import type { Browser, Page } from "playwright";
import type { StoryEntry, ResolvedSnapshotConfig, SnapshotMode } from "../types.ts";

// tsconfig has no "dom" lib; declare the globals the in-page callbacks below
// touch rather than casting through `any` at every use.
declare const window: any;
declare const document: any;

export interface CaptureResult {
  storyKey: string;
  viewport: { width: number; height: number; name?: string };
  /** Name of the snapshot mode this was captured in; unset when none are configured. */
  mode?: string;
  buffer: Buffer;
  outputPath: string;
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

// By the time this runs, the caller has already awaited __STORYBUN_READY__
// (captureAll does, and direct callers must too -- see capture.test.ts), and
// readiness itself is only signalled after `document.fonts.ready` plus two
// animation frames past the render/error branch in entry.ts. So the marker
// (or the known-error state) should already be settled; this timeout is a
// small safety margin for residual layout, not a real "wait for render".
const MARKER_TIMEOUT_MS = 500;

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
// than one root) -- plus whatever the story portaled out of the tree. A menu,
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
  const bodyChildren = document.body.children as ArrayLike<any>;
  for (let i = 0; i < bodyChildren.length; i++) {
    const el = bodyChildren[i];
    if (el.contains(marker)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    roots.push(el);
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
    const docLeft = rect.left + scrollX;
    const docTop = rect.top + scrollY;
    left = Math.min(left, docLeft);
    top = Math.min(top, docTop);
    right = Math.max(right, docLeft + rect.width);
    bottom = Math.max(bottom, docTop + rect.height);
  }

  const x = Math.floor(left);
  const y = Math.floor(top);
  const width = Math.ceil(right) - x;
  const height = Math.ceil(bottom) - y;

  return { x, y, width, height };
}

/**
 * Captures the story's own rendered box: the union of the bounding rects of
 * the marker's element children and of anything the story portaled next to
 * the app root, cropped out of a full-page screenshot.
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
  timeoutMs: number = MARKER_TIMEOUT_MS,
): Promise<Buffer> {
  const marker = page.locator("[data-storybun-story]");

  // `attached`, not `visible`: a story that only portals (a dialog) leaves
  // the marker itself with no box. Whether there is anything to capture is
  // decided by the measurement below, which also covers the portaled roots.
  try {
    await marker.waitFor({ state: "attached", timeout: timeoutMs });
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
      `[storybun] ${storyKey}: no story marker appeared within ${timeoutMs}ms and the entry did not report a known error state -- the story may be stuck rendering. Refusing to fall back to a full-page screenshot that could be mistaken for a valid baseline.`,
    );
    throw waitErr;
  }

  const rect = await page.evaluate(measureStoryRect);
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    console.error(
      `[storybun] ${storyKey}: the story rendered nothing with a measurable box, inline or portaled (e.g. it rendered null, or all of its root elements collapsed to zero size) -- refusing to produce a zero-size or viewport-sized image.`,
    );
    throw new Error(
      `${storyKey}: story marker has no measurable content to capture`,
    );
  }

  return Buffer.from(
    await page.screenshot({ type: "png", fullPage: true, clip: rect }),
  );
}

/**
 * A page pinned to a deterministic environment. Timezone and locale are fixed so
 * a developer's machine renders what CI renders, and a fixed time freezes
 * `Date.now()` and `new Date()` so components that read the wall clock -- relative
 * timestamps, elapsed-time tickers -- paint the same pixels on every run instead
 * of diffing against their own baseline. Timers keep running and only the reported
 * time is frozen, so nothing that awaits a timeout can deadlock.
 *
 * A page is good for exactly ONE navigation once the clock is frozen. On the
 * second and later `goto`, React still commits -- the DOM is fully populated --
 * but the compositor never paints, and `page.screenshot()` returns a blank canvas
 * while every wait in the loop reports success. Reusing a page therefore captures
 * the first story correctly and writes every later story on that page as an empty
 * image, with no error anywhere. `captureAll` takes a fresh page per story for
 * that reason; see its comment before changing it back.
 */
async function createPage(
  browser: Browser,
  config: ResolvedSnapshotConfig,
  fixedTime: Date | null,
  mode: SnapshotMode | undefined,
): Promise<Page> {
  // `colorScheme` is left undefined when the mode does not set it: Playwright
  // then reports `light`, the same as before modes existed, so a mode that
  // only overrides the locale still renders the light theme.
  const page = await browser.newPage({
    timezoneId: mode?.timezoneId ?? config.timezoneId,
    locale: mode?.locale ?? config.locale,
    colorScheme: mode?.colorScheme,
  });
  if (fixedTime) {
    await page.clock.setFixedTime(fixedTime);
  }
  return page;
}

/**
 * Navigate to a story and wait until it has painted. Shared by the baseline run
 * and the single-story `shot` command so both observe the same readiness
 * contract -- fonts loaded, two animation frames elapsed, plus any configured
 * settle time -- and cannot drift into capturing at different moments.
 */
export async function renderStory(
  page: Page,
  serverUrl: string,
  storyKey: string,
  config: ResolvedSnapshotConfig,
): Promise<void> {
  const url = `${serverUrl}/snapshot?story=${encodeURIComponent(storyKey)}`;

  await page.goto(url, { waitUntil: "networkidle" });

  // Wait for the ready signal
  await page.waitForFunction(
    () => window.__STORYBUN_READY__ === true,
    { timeout: 30_000 },
  );

  // Optional extra wait
  if (config.waitTimeout > 0) {
    await page.waitForTimeout(config.waitTimeout);
  }
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
 * Goes through the same page setup, readiness wait and story-box crop as
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
  const page = await createPage(
    browser,
    config,
    resolveFixedTime(config.clock),
    options.mode,
  );
  try {
    await page.setViewportSize(options.viewport);
    await renderStory(page, serverUrl, options.storyKey, config);
    return await captureStoryOrPage(page, options.storyKey);
  } finally {
    await page.close();
  }
}

export async function captureAll(
  browser: Browser,
  stories: StoryEntry[],
  config: ResolvedSnapshotConfig,
  serverUrl: string,
  filter?: string,
): Promise<CaptureResult[]> {
  const results: CaptureResult[] = [];
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

  // Process with a concurrency pool. Each worker opens a fresh page per story
  // rather than holding one for its whole queue: a frozen clock survives exactly
  // one navigation, and a reused page silently screenshots blank from the second
  // story onwards (see `createPage`). Opening a page costs a fraction of the
  // per-story wait, and a blank baseline is invisible in CI -- it matches the next
  // equally blank run -- so the trade is not close.
  const concurrency = Math.min(config.concurrency, work.length || 1);
  const fixedTime = resolveFixedTime(config.clock);

  let cursor = 0;

  async function captureStory(item: (typeof work)[number]): Promise<void> {
    const page = await createPage(browser, config, fixedTime, item.mode);

    try {
      await page.setViewportSize({
        width: item.viewport.width,
        height: item.viewport.height,
      });

      const storyKey = `${item.storyPath}--${item.exportName}`;
      await renderStory(page, serverUrl, storyKey, config);

      const buffer = await captureStoryOrPage(page, storyKey);

      results.push({
        storyKey,
        viewport: item.viewport,
        mode: item.modeName,
        buffer,
        outputPath: item.outputPath,
      });
    } finally {
      await page.close();
    }
  }

  async function worker() {
    while (cursor < work.length) {
      await captureStory(work[cursor++]!);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // No pool to tear down: `captureStory` closes its own page in a `finally`, so a
  // story that throws does not leak one either.
  return results;
}
