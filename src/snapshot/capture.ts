import type { Browser, Page } from "playwright";
import type { StoryEntry, ResolvedSnapshotConfig } from "../types.ts";

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
    const page = await createPage(browser, config, fixedTime);

    try {
      await page.setViewportSize({
        width: item.viewport.width,
        height: item.viewport.height,
      });

      const storyKey = `${item.storyPath}--${item.exportName}`;
      const url = `${serverUrl}/snapshot?story=${encodeURIComponent(storyKey)}`;

      await page.goto(url, { waitUntil: "networkidle" });

      // Wait for the ready signal
      await page.waitForFunction(
        () => (window as any).__STORYBUN_READY__ === true,
        { timeout: 30_000 },
      );

      // Optional extra wait
      if (config.waitTimeout > 0) {
        await page.waitForTimeout(config.waitTimeout);
      }

      const buffer = await page.screenshot({ type: "png" });

      results.push({
        storyKey,
        viewport: item.viewport,
        buffer: Buffer.from(buffer),
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
