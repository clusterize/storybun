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

/**
 * Captures the story's own marker element, cropped to its own box.
 *
 * Error paths in the generated entry (missing ?story=, bad key, story not
 * found, export not found, thrown render) leave no marker in the DOM and
 * instead set `document.body.dataset.storybunError`. That is the only case
 * that legitimately falls back to a full-page screenshot -- and even then a
 * warning is printed naming the story, so a degraded baseline can't pass
 * unnoticed.
 *
 * Any other reason the marker fails to appear (e.g. a story that renders
 * `null` and never settles) is NOT a known error state and is NOT swallowed:
 * it's logged loudly and thrown, rather than silently producing a
 * viewport-sized screenshot that could be accepted as a baseline. A genuine
 * screenshot failure (marker or full page) is likewise never caught here.
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

  return Buffer.from(await marker.screenshot({ type: "png" }));
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
