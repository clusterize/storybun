import type { Browser, Page } from "playwright";
import type { StoryEntry, ResolvedSnapshotConfig } from "../types.ts";

// tsconfig has no "dom" lib; declare the globals the in-page callbacks below
// touch rather than casting through `any` at every use.
declare const window: any;
declare const document: any;

export interface CaptureResult {
  storyKey: string;
  viewport: { width: number; height: number; name?: string };
  buffer: Buffer;
  outputPath: string;
}

function storyOutputPath(
  outDir: string,
  storyPath: string,
  exportName: string,
  viewport: { width: number; height: number; name?: string },
  singleViewport: boolean,
): string {
  const safePath = storyPath.replace(/\//g, "--");
  const key = `${safePath}--${exportName}`;
  if (singleViewport) {
    return `${outDir}/${key}.png`;
  }
  const vpName = viewport.name ?? `${viewport.width}x${viewport.height}`;
  return `${outDir}/${key}-${vpName}.png`;
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
// than one root). Coordinates are made document-relative (adding the current
// scroll offset) rather than viewport-relative, because the capture below
// uses `fullPage: true` so content below the fold is included.
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

  const children = marker.children as ArrayLike<any>;
  if (children.length === 0) return null;

  const scrollX = window.scrollX;
  const scrollY = window.scrollY;

  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < children.length; i++) {
    const rect = children[i]!.getBoundingClientRect();
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
 * the marker's element children, cropped out of a full-page screenshot.
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

  try {
    await marker.waitFor({ state: "visible", timeout: timeoutMs });
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
      `[storybun] ${storyKey}: no story marker became visible within ${timeoutMs}ms and the entry did not report a known error state -- the story may be stuck rendering (e.g. returning null forever). Refusing to fall back to a full-page screenshot that could be mistaken for a valid baseline.`,
    );
    throw waitErr;
  }

  const rect = await page.evaluate(measureStoryRect);
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    console.error(
      `[storybun] ${storyKey}: the story marker is visible but its rendered content has no measurable box (e.g. it rendered null, or all of its root elements collapsed to zero size) -- refusing to produce a zero-size or viewport-sized image.`,
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
 */
async function createPage(
  browser: Browser,
  config: ResolvedSnapshotConfig,
  fixedTime: Date | null,
): Promise<Page> {
  const page = await browser.newPage({
    timezoneId: config.timezoneId,
    locale: config.locale,
  });
  if (fixedTime) {
    await page.clock.setFixedTime(fixedTime);
  }
  return page;
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

  // Build work items: story × export × viewport
  interface WorkItem {
    storyPath: string;
    exportName: string;
    viewport: { width: number; height: number; name?: string };
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
        work.push({
          storyPath: story.path,
          exportName,
          viewport,
          outputPath: storyOutputPath(
            config.outDir,
            story.path,
            exportName,
            viewport,
            singleViewport,
          ),
        });
      }
    }
  }

  // Process with concurrency pool
  const concurrency = Math.min(config.concurrency, work.length || 1);
  const fixedTime = resolveFixedTime(config.clock);
  const pages = await Promise.all(
    Array.from({ length: concurrency }, () =>
      createPage(browser, config, fixedTime),
    ),
  );

  let cursor = 0;

  async function processPage(page: Page) {
    while (cursor < work.length) {
      const item = work[cursor++]!;
      await page.setViewportSize({
        width: item.viewport.width,
        height: item.viewport.height,
      });

      const storyKey = `${item.storyPath}--${item.exportName}`;
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

      const buffer = await captureStoryOrPage(page, storyKey);

      results.push({
        storyKey,
        viewport: item.viewport,
        buffer,
        outputPath: item.outputPath,
      });
    }
  }

  await Promise.all(pages.map(processPage));

  for (const page of pages) {
    await page.close();
  }

  return results;
}
