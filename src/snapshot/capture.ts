import type { Browser, BrowserContext, Page } from "playwright";
import type { StoryEntry, ResolvedSnapshotConfig, SnapshotMode } from "../types.ts";
import type { CaptureHooks } from "./progress.ts";
import { pngDimensions, type PngDimensions } from "./png.ts";

// tsconfig has no "dom" lib; declare the globals the in-page callbacks below
// touch rather than casting through `any` at every use.
declare const window: any;
declare const document: any;
declare const MutationObserver: any;
declare const requestAnimationFrame: any;

/** A story that could not be captured; the run goes on without it. */
export interface CaptureFailure {
  storyKey: string;
  viewport: { width: number; height: number; name?: string };
  mode?: string;
  /** The baseline this capture would have been compared against. */
  outputPath: string;
  error: Error;
}

/**
 * What `captureAll` keeps of a capture once its hook has run: everything but
 * the pixels. The PNG itself is handed to `hooks.onCapture` and dropped, so a
 * run holds at most `concurrency` images in memory, not one per story.
 */
export interface CaptureRecord {
  storyKey: string;
  viewport: { width: number; height: number; name?: string };
  /** Name of the snapshot mode this was captured in; unset when none are configured. */
  mode?: string;
  outputPath: string;
  dimensions: PngDimensions;
}

export interface CaptureResult extends CaptureRecord {
  buffer: Buffer;
}

export interface CaptureOutcome {
  captures: CaptureRecord[];
  failures: CaptureFailure[];
}

// The bare `<key>.png` name is kept for the single-viewport, no-modes case so
// that enabling neither feature never renames a baseline. Each extra axis
// appends its own suffix, viewport before mode, so a project that turns on
// modes re-baselines exactly once (`X.png` -> `X-light.png`, `X-dark.png`).
function storyOutputPath(
  outDir: string,
  storyPath: string,
  exportName: string,
  viewport: { width: number; height: number; name?: string },
  singleViewport: boolean,
  modeName: string | undefined,
): string {
  const safePath = storyPath.replace(/\//g, "--");
  let key = `${safePath}--${exportName}`;
  if (!singleViewport) {
    key += `-${viewport.name ?? `${viewport.width}x${viewport.height}`}`;
  }
  if (modeName !== undefined) {
    key += `-${modeName}`;
  }
  return `${outDir}/${key}.png`;
}

// A mode name becomes part of a filename and of the `<key>--<export>-<mode>`
// suffix the report prints, so it must not contain a path separator or a
// character that would make the baseline unparseable by the tooling that
// reads the snapshot directory.
function validateModeNames(modes: Record<string, SnapshotMode>): void {
  for (const name of Object.keys(modes)) {
    if (!/^[A-Za-z0-9_.]+$/.test(name)) {
      throw new Error(
        `Invalid snapshot mode name ${JSON.stringify(name)}: use letters, digits, "_" or "." only, since it becomes part of the baseline filename.`,
      );
    }
  }
}

function resolveFixedTime(clock: string | null): Date | null {
  if (!clock) return null;
  const time = new Date(clock);
  if (Number.isNaN(time.getTime())) {
    throw new Error(
      `Invalid snapshot.clock: ${JSON.stringify(clock)} is not a parseable date.`,
    );
  }
  return time;
}

// By the time this runs, `renderStory` has already waited for the story to
// settle, and settling requires the marker to be attached with a measurable
// box. So the marker should already be there; this timeout is a small safety
// margin for a caller that drives the page itself, not a real "wait for
// render".
const MARKER_TIMEOUT_MS = 500;

/** Pause between two settle probes, so a story mid-render is not hammered. */
const SETTLE_POLL_MS = 50;

interface StoryRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// The marker div is block-level and always fills its container, so its own
// box tells us nothing about the story's size. What we actually want is the
// box the story itself occupies: the union of its rendered root(s) -- the
// marker's direct element children (a story can render a fragment with more
// than one root) -- plus whatever the story portaled out of the tree or
// pinned to the viewport with `position: fixed`. A menu,
// popover, tooltip or dialog rendered open is mounted by its library as a
// direct child of `document.body`, next to the app root rather than under
// the marker, so measuring the marker's children alone would capture an open
// dropdown as nothing but its trigger. Every body child that does not contain
// the marker and has a box is therefore part of the story: the only other
// things at that level are the app root and script/style tags, which have no
// box. Coordinates are made document-relative (adding the current scroll
// offset) rather than viewport-relative, because the capture below uses
// `fullPage: true` so content below the fold is included.
//
// Left/top are floored and right/bottom are ceiled rather than rounded to
// the nearest pixel: `getBoundingClientRect()` returns fractional values,
// and a plain round could clip a fraction of a pixel of real content on one
// run and not another depending on which side of .5 it fell. Rounding
// outward always fully contains the content and is deterministic run to
// run, which matters because these images become diffed baselines.
//
// This function is serialised and evaluated inside the page, so it must stay
// self-contained: no reference to anything else in this module.
function measureStoryRect(): StoryRect | null {
  const marker = document.querySelector("[data-storybun-story]");
  if (!marker) return null;

  // A story may render nothing inline at all -- a dialog story is only its
  // portal -- so an empty marker is not yet a failure; no roots anywhere is.
  const children = marker.children as ArrayLike<any>;
  const roots: any[] = [];
  for (let i = 0; i < children.length; i++) {
    roots.push(children[i]);
  }
  // A portal container itself may have no box: some libraries mount an
  // empty wrapper and position the popup absolutely inside it. Everything
  // under such a container is story content, so its descendants count too.
  const bodyChildren = document.body.children as ArrayLike<any>;
  for (let i = 0; i < bodyChildren.length; i++) {
    const el = bodyChildren[i];
    if (el.contains(marker)) continue;
    roots.push(el);
    const portaled = el.querySelectorAll("*") as ArrayLike<any>;
    for (let j = 0; j < portaled.length; j++) {
      roots.push(portaled[j]);
    }
  }
  // A fixed-position descendant (a toast, a banner, a floating action) is
  // laid out against the viewport, so its ancestor's box says nothing about
  // where it is; it is part of the story all the same. Its own descendants
  // count with it: a toaster is a fixed list with no height of its own whose
  // toasts are positioned absolutely inside it.
  const descendants = marker.querySelectorAll("*") as ArrayLike<any>;
  for (let i = 0; i < descendants.length; i++) {
    const el = descendants[i];
    if (window.getComputedStyle(el).position !== "fixed") continue;
    roots.push(el);
    const inner = el.querySelectorAll("*") as ArrayLike<any>;
    for (let j = 0; j < inner.length; j++) {
      roots.push(inner[j]);
    }
  }
  if (roots.length === 0) return null;

  const scrollX = window.scrollX;
  const scrollY = window.scrollY;

  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;

  for (const el of roots) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const docLeft = rect.left + scrollX;
    const docTop = rect.top + scrollY;
    left = Math.min(left, docLeft);
    top = Math.min(top, docTop);
    right = Math.max(right, docLeft + rect.width);
    bottom = Math.max(bottom, docTop + rect.height);
  }

  if (!Number.isFinite(left)) return null;

  const x = Math.floor(left);
  const y = Math.floor(top);
  const width = Math.ceil(right) - x;
  const height = Math.ceil(bottom) - y;

  return { x, y, width, height };
}

/** One probe of the in-page readiness contract. */
interface SettleVerdict {
  settled: boolean;
  /** Why the story is not settled yet; named in the error when the cap is hit. */
  reason?: string;
}

// The readiness contract, evaluated inside the page. `__STORYBUN_READY__` is
// a first-paint heuristic (render scheduled, fonts ready, two frames); this
// is what actually decides that the story is done rendering. Each condition
// below closes a gap that a blind `waitTimeout` sleep used to paper over:
//
// - the marker must be committed with a measurable box (React commits are
//   scheduled, and under load the two frames pass before the story is in
//   the DOM; a story that returns null until its data arrives has a marker
//   but no box);
// - `window.__storybunPending`, a counter (or a function returning one) the
//   host Wrapper may drive from its data layer, must be zero -- the only
//   signal that knows about a re-render that has not happened yet;
// - fonts loaded, every image complete, every framed document loaded;
// - no animation running: with reduced motion emulated and CSS durations
//   zeroed that is almost always true at once; a finite animation that is
//   not is simply waited for, and one that would never end (infinite
//   iterations, a spinner) is paused at its first frame so the story can
//   settle at all, and settle on the same frame every run;
// - the DOM did not mutate and the measured box did not move across two
//   consecutive frames.
//
// It runs again and again until it says settled or the cap is hit, so it
// must be cheap, and it must be self-contained apart from `measureStoryRect`,
// which the caller splices into the same script.
async function checkSettled(): Promise<SettleVerdict> {
  // The entry rendered an error message instead of a story. Nothing more
  // will arrive, so there is nothing to wait for.
  if (document.body.dataset.storybunError === "true") return { settled: true };

  if (!document.querySelector("[data-storybun-story]")) {
    return { settled: false, reason: "the story marker has not been committed to the DOM" };
  }

  const pending = window.__storybunPending;
  const pendingCount = typeof pending === "function" ? Number(pending()) : Number(pending ?? 0);
  if (pendingCount > 0) {
    return {
      settled: false,
      reason: `window.__storybunPending reports ${pendingCount} pending operation(s)`,
    };
  }

  if (document.fonts.status === "loading") {
    return { settled: false, reason: "fonts are still loading" };
  }

  const images = document.images as ArrayLike<any>;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    // A lazy image outside the viewport never starts loading, and the
    // full-page capture shows it as the browser would: not yet loaded.
    if (img.loading === "lazy") {
      const r = img.getBoundingClientRect();
      const visible = r.bottom > 0 && r.right > 0 && r.top < viewportHeight && r.left < viewportWidth;
      if (!visible) continue;
    }
    if (!img.complete) {
      return { settled: false, reason: `an image is still loading (${img.currentSrc || img.src || "no src"})` };
    }
  }

  const frames = document.querySelectorAll("iframe") as ArrayLike<any>;
  const loadedFrames = window.__storybunLoadedFrames;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const src = frame.getAttribute("src");
    const hasSource = (src !== null && src !== "" && src !== "about:blank") || frame.hasAttribute("srcdoc");
    if (!hasSource) continue;
    if (loadedFrames && !loadedFrames.has(frame)) {
      return { settled: false, reason: `an iframe has not fired load yet (${src ?? "srcdoc"})` };
    }
    // A cross-origin document is opaque; the load event above is all there
    // is. A same-origin one must also have left the initial about:blank
    // behind and finished parsing.
    let doc: any = null;
    try {
      doc = frame.contentDocument;
    } catch {}
    if (doc && (doc.URL === "about:blank" || doc.readyState !== "complete")) {
      return { settled: false, reason: `an iframe document is still loading (${src ?? "srcdoc"})` };
    }
  }

  const animations = document.getAnimations() as any[];
  let running = 0;
  for (const animation of animations) {
    if (animation.playState !== "running") continue;
    const timing = animation.effect?.getTiming?.();
    if (timing && timing.iterations === Infinity) {
      animation.currentTime = 0;
      animation.pause();
      continue;
    }
    running++;
  }
  if (running > 0) {
    return { settled: false, reason: `${running} animation(s) still running` };
  }

  // Finally: nothing may change for two frames. A MutationObserver catches a
  // late commit or a text swap; the serialised story box catches a layout
  // shift that touches no DOM node (an image taking its size, a font swap).
  const rectBefore = measureStoryRect();
  const layoutBefore = JSON.stringify(rectBefore) + "|" + document.documentElement.scrollWidth + "x" + document.documentElement.scrollHeight;
  let mutations = 0;
  const observer = new MutationObserver((records: any[]) => {
    mutations += records.length;
  });
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
  observer.disconnect();
  const rectAfter = measureStoryRect();
  const layoutAfter = JSON.stringify(rectAfter) + "|" + document.documentElement.scrollWidth + "x" + document.documentElement.scrollHeight;

  if (mutations > 0) {
    return { settled: false, reason: `the DOM changed between two frames (${mutations} mutation(s))` };
  }
  if (layoutBefore !== layoutAfter) {
    return { settled: false, reason: "the layout changed between two frames" };
  }
  if (!rectAfter || rectAfter.width <= 0 || rectAfter.height <= 0) {
    return {
      settled: false,
      reason: "the story has rendered nothing with a measurable box, inline or portaled",
    };
  }

  // Every image is complete; make sure its pixels are decoded too, so the
  // screenshot does not catch a placeholder a frame before the bitmap lands.
  const decodes: Promise<void>[] = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (img.complete && img.naturalWidth > 0 && typeof img.decode === "function") {
      decodes.push(img.decode().catch(() => {}));
    }
  }
  await Promise.all(decodes);

  return { settled: true };
}

// `measureStoryRect` is spliced into the same script because Playwright
// serialises only the function it is handed, not what that function closes
// over. Built once; the probe runs many times per story.
const SETTLE_PROBE = `(() => { const measureStoryRect = ${measureStoryRect.toString()}; return (${checkSettled.toString()})(); })()`;

/**
 * Poll the in-page readiness contract until the story is settled, or fail
 * loudly once `timeoutMs` has passed, naming the story and the condition it
 * was still waiting on. Nothing here falls back to a blank or partial image.
 */
export async function waitForSettled(
  page: Page,
  storyKey: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastReason = "unknown";
  for (;;) {
    const verdict = (await page.evaluate(SETTLE_PROBE)) as SettleVerdict;
    if (verdict.settled) return;
    lastReason = verdict.reason ?? lastReason;
    if (Date.now() >= deadline) {
      throw new Error(
        `${storyKey}: story did not settle within ${timeoutMs}ms: ${lastReason}`,
      );
    }
    await page.waitForTimeout(SETTLE_POLL_MS);
  }
}

export interface CaptureStoryOptions {
  /** How long to wait for the marker to attach; a safety margin, see `MARKER_TIMEOUT_MS`. */
  markerTimeoutMs?: number;
  /** Cap on the two-identical-screenshots backstop, see `settleTimeout`. */
  settleTimeoutMs?: number;
}

/**
 * Captures the story's own rendered box: the union of the bounding rects of
 * the marker's element children and of anything the story portaled next to
 * the app root, cropped out of a full-page screenshot.
 *
 * Two consecutive screenshots must be identical before one is accepted. The
 * settle contract `renderStory` enforces covers everything the page can
 * observe about itself; this is the backstop for what it cannot (a canvas
 * being painted, a video frame, a compositor still catching up), at the price
 * of one extra screenshot rather than seconds of sleep. A story still
 * repainting at the cap fails, naming itself.
 *
 * Error paths in the generated entry (missing ?story=, bad key, story not
 * found, export not found, thrown render) leave no marker in the DOM and
 * instead set `document.body.dataset.storybunError`. That is the only case
 * that legitimately falls back to a full-page screenshot -- and even then a
 * warning is printed naming the story, so a degraded baseline can't pass
 * unnoticed.
 *
 * Any other reason the marker fails to appear or produce a measurable box
 * (e.g. a story that renders `null` and never settles, or whose roots all
 * collapse to zero size) is NOT a known error state and is NOT swallowed:
 * it's logged loudly and thrown, rather than silently producing a
 * zero-size or viewport-sized screenshot that could be accepted as a
 * baseline. A genuine screenshot failure (marker or full page) is likewise
 * never caught here.
 */
export async function captureStoryOrPage(
  page: Page,
  storyKey: string = "<unknown story>",
  options: CaptureStoryOptions = {},
): Promise<Buffer> {
  const markerTimeoutMs = options.markerTimeoutMs ?? MARKER_TIMEOUT_MS;
  const settleTimeoutMs = options.settleTimeoutMs ?? 10_000;
  const marker = page.locator("[data-storybun-story]");

  // `attached`, not `visible`: a story that only portals (a dialog) leaves
  // the marker itself with no box. Whether there is anything to capture is
  // decided by the measurement below, which also covers the portaled roots.
  try {
    await marker.waitFor({ state: "attached", timeout: markerTimeoutMs });
  } catch (waitErr) {
    const isKnownErrorState = await page
      .evaluate(() => document.body.dataset.storybunError === "true")
      .catch(() => false);

    if (isKnownErrorState) {
      console.warn(
        `[storybun] ${storyKey}: entry reported an error state (no story marker to capture) -- falling back to a full-page screenshot.`,
      );
      return Buffer.from(await page.screenshot({ type: "png" }));
    }

    console.error(
      `[storybun] ${storyKey}: no story marker appeared within ${markerTimeoutMs}ms and the entry did not report a known error state -- the story may be stuck rendering. Refusing to fall back to a full-page screenshot that could be mistaken for a valid baseline.`,
    );
    throw waitErr;
  }

  const deadline = Date.now() + settleTimeoutMs;
  let previous: { rect: StoryRect; buffer: Buffer } | null = null;
  for (;;) {
    const rect = await page.evaluate(measureStoryRect);
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      console.error(
        `[storybun] ${storyKey}: the story rendered nothing with a measurable box, inline or portaled (e.g. it rendered null, or all of its root elements collapsed to zero size) -- refusing to produce a zero-size or viewport-sized image.`,
      );
      throw new Error(
        `${storyKey}: story marker has no measurable content to capture`,
      );
    }

    const buffer = Buffer.from(
      await page.screenshot({ type: "png", fullPage: true, clip: rect }),
    );
    if (
      previous &&
      previous.rect.x === rect.x &&
      previous.rect.y === rect.y &&
      previous.rect.width === rect.width &&
      previous.rect.height === rect.height &&
      previous.buffer.equals(buffer)
    ) {
      return buffer;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${storyKey}: two consecutive screenshots still differ after ${settleTimeoutMs}ms; the story keeps repainting`,
      );
    }
    previous = { rect, buffer };
  }
}

/**
 * A browser context pinned to a deterministic environment. Timezone and
 * locale are fixed so a developer's machine renders what CI renders, and a
 * fixed time freezes `Date.now()` and `new Date()` so components that read the
 * wall clock -- relative timestamps, elapsed-time tickers -- paint the same
 * pixels on every run instead of diffing against their own baseline. Timers
 * keep running and only the reported time is frozen, so nothing that awaits a
 * timeout can deadlock.
 *
 * The clock is a context-level thing in Playwright (`page.clock` is sugar for
 * `context.clock`), so it is frozen here, once per context, rather than per
 * page: calling `setFixedTime` for every page while sibling pages in the same
 * context close raced with "Target page, context or browser has been closed".
 *
 * Reduced motion is emulated for every capture. Motion libraries and consumer
 * stylesheets with a `prefers-reduced-motion` branch then switch their own
 * animation off, which is both faster and more faithful than a CSS override
 * could be. Turning this on is a one-time re-baseline for a project whose
 * components honour the preference.
 */
async function createContext(
  browser: Browser,
  config: ResolvedSnapshotConfig,
  fixedTime: Date | null,
  mode: SnapshotMode | undefined,
): Promise<BrowserContext> {
  // `colorScheme` is left undefined when the mode does not set it: Playwright
  // then reports `light`, the same as before modes existed, so a mode that
  // only overrides the locale still renders the light theme.
  const context = await browser.newContext({
    timezoneId: mode?.timezoneId ?? config.timezoneId,
    locale: mode?.locale ?? config.locale,
    colorScheme: mode?.colorScheme,
    reducedMotion: "reduce",
  });
  if (fixedTime) {
    await context.clock.setFixedTime(fixedTime);
  }
  return context;
}

/**
 * Navigate to a story and wait until it has settled. Shared by the baseline
 * run and the single-story `shot` command so both observe the same readiness
 * contract -- the entry's ready signal, then `checkSettled` until it holds or
 * `settleTimeout` runs out -- and cannot drift into capturing at different
 * moments.
 *
 * `load`, not `networkidle`: the latter cost a fixed 500ms of silence per
 * capture and only covered images by accident. The settle contract waits for
 * what the story actually shows.
 */
export async function renderStory(
  page: Page,
  serverUrl: string,
  storyKey: string,
  config: ResolvedSnapshotConfig,
): Promise<void> {
  const url = `${serverUrl}/snapshot?story=${encodeURIComponent(storyKey)}`;

  await page.goto(url, { waitUntil: "load" });

  // Wait for the ready signal
  await page.waitForFunction(
    () => window.__STORYBUN_READY__ === true,
    { timeout: 30_000 },
  );

  await waitForSettled(page, storyKey, config.settleTimeout);
}

export interface ShotOptions {
  storyKey: string;
  viewport: { width: number; height: number };
  /** Environment to capture in; `undefined` is the browser default, as for an unconfigured baseline run. */
  mode: SnapshotMode | undefined;
}

/**
 * Capture a single story to a PNG buffer, touching no baseline on disk.
 *
 * Goes through the same context setup, readiness wait and story-box crop as
 * `captureAll`, so the image is byte-for-byte what a baseline run would write
 * for this story in this mode and viewport -- not a viewport screenshot that
 * merely resembles one.
 */
export async function captureOne(
  browser: Browser,
  config: ResolvedSnapshotConfig,
  serverUrl: string,
  options: ShotOptions,
): Promise<Buffer> {
  const context = await createContext(
    browser,
    config,
    resolveFixedTime(config.clock),
    options.mode,
  );
  try {
    const page = await context.newPage();
    await page.setViewportSize(options.viewport);
    await renderStory(page, serverUrl, options.storyKey, config);
    return await captureStoryOrPage(page, options.storyKey, {
      settleTimeoutMs: config.settleTimeout,
    });
  } finally {
    await context.close();
  }
}

export async function captureAll(
  browser: Browser,
  stories: StoryEntry[],
  config: ResolvedSnapshotConfig,
  serverUrl: string,
  filter?: string,
  hooks: CaptureHooks = {},
): Promise<CaptureOutcome> {
  const results: CaptureRecord[] = [];
  const failures: CaptureFailure[] = [];
  const singleViewport = config.viewports.length === 1;

  validateModeNames(config.modes);
  // No configured modes still means one capture per story x viewport, in the
  // browser's default environment and under the unsuffixed filename.
  const modeEntries: [string | undefined, SnapshotMode | undefined][] =
    Object.keys(config.modes).length === 0
      ? [[undefined, undefined]]
      : Object.entries(config.modes);

  // Build work items: story × export × viewport × mode
  interface WorkItem {
    storyPath: string;
    exportName: string;
    viewport: { width: number; height: number; name?: string };
    modeName: string | undefined;
    mode: SnapshotMode | undefined;
    outputPath: string;
  }
  const work: WorkItem[] = [];

  for (const story of stories) {
    for (const exportName of story.exports) {
      if (filter) {
        const key = `${story.path}--${exportName}`;
        if (!key.includes(filter)) continue;
      }
      for (const viewport of config.viewports) {
        for (const [modeName, mode] of modeEntries) {
          work.push({
            storyPath: story.path,
            exportName,
            viewport,
            modeName,
            mode,
            outputPath: storyOutputPath(
              config.outDir,
              story.path,
              exportName,
              viewport,
              singleViewport,
              modeName,
            ),
          });
        }
      }
    }
  }

  const concurrency = Math.min(config.concurrency, work.length || 1);
  const fixedTime = resolveFixedTime(config.clock);

  hooks.onStart?.(work.length);

  // One context per mode, shared by every page captured in that mode, with
  // the clock frozen once on it (see `createContext`). Each capture still
  // gets a fresh page: a page reused across navigations under a frozen clock
  // screenshots blank from the second story on, with every wait reporting
  // success, and a blank baseline is invisible in CI because it matches the
  // next equally blank run. Opening a page is cheap next to rendering one.
  const contexts = new Map<string | undefined, BrowserContext>();
  for (const [modeName, mode] of modeEntries) {
    contexts.set(modeName, await createContext(browser, config, fixedTime, mode));
  }

  let cursor = 0;
  let finished = 0;

  // One story that cannot be captured must not take the other hundred with
  // it: a run that aborts on the first failure reports one problem per CI
  // round trip and writes no comparison for the stories that did render. The
  // failure is kept, with its story key, and the run goes on; the caller
  // reports every failure together and fails the run on any.
  //
  // The capture hook (compare, or write the baseline) runs here, inside the
  // worker, as soon as the screenshot exists: the PNG is then dropped and
  // only its dimensions kept, so memory holds `concurrency` images rather
  // than the whole suite, and a comparison overlaps with the next render
  // instead of running as a serial pass afterwards. A hook that throws
  // fails this capture, not the run.
  async function captureStory(item: WorkItem): Promise<void> {
    const storyKey = `${item.storyPath}--${item.exportName}`;
    const startedAt = performance.now();
    let error: Error | undefined;
    let outcome: string | undefined;
    const page = await contexts.get(item.modeName)!.newPage();

    try {
      await page.setViewportSize({
        width: item.viewport.width,
        height: item.viewport.height,
      });

      await renderStory(page, serverUrl, storyKey, config);

      const buffer = await captureStoryOrPage(page, storyKey, {
        settleTimeoutMs: config.settleTimeout,
      });
      const dimensions = pngDimensions(buffer);
      if (!dimensions) {
        throw new Error(`${storyKey}: the screenshot is not a PNG`);
      }

      const capture: CaptureResult = {
        storyKey,
        viewport: item.viewport,
        mode: item.modeName,
        buffer,
        outputPath: item.outputPath,
        dimensions,
      };
      const note = await hooks.onCapture?.(capture);
      if (typeof note === "string") outcome = note;

      results.push({
        storyKey,
        viewport: item.viewport,
        mode: item.modeName,
        outputPath: item.outputPath,
        dimensions,
      });
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
      failures.push({
        storyKey,
        viewport: item.viewport,
        mode: item.modeName,
        outputPath: item.outputPath,
        error,
      });
    } finally {
      await page.close();
      hooks.onProgress?.({
        index: ++finished,
        total: work.length,
        storyKey,
        mode: item.modeName,
        viewport: item.viewport,
        durationMs: performance.now() - startedAt,
        error,
        outcome,
      });
    }
  }

  async function worker() {
    while (cursor < work.length) {
      await captureStory(work[cursor++]!);
    }
  }

  try {
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  } finally {
    // `captureStory` closes its own page in a `finally`, so a story that
    // throws does not leak one; the contexts are torn down here.
    for (const context of contexts.values()) {
      await context.close();
    }
  }

  return { captures: results, failures };
}
