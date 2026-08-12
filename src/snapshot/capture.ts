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
 */
export async function createPage(
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
    () => (window as any).__STORYBUN_READY__ === true,
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
  fullPage: boolean;
}

/** Capture a single story to a PNG buffer, touching no baseline on disk. */
export async function captureOne(
  browser: Browser,
  config: ResolvedSnapshotConfig,
  serverUrl: string,
  options: ShotOptions,
): Promise<Buffer> {
  const page = await createPage(browser, config, resolveFixedTime(config.clock));
  try {
    await page.setViewportSize(options.viewport);
    await renderStory(page, serverUrl, options.storyKey, config);
    const buffer = await page.screenshot({
      type: "png",
      fullPage: options.fullPage,
    });
    return Buffer.from(buffer);
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
      await renderStory(page, serverUrl, storyKey, config);

      const buffer = await page.screenshot({ type: "png" });

      results.push({
        storyKey,
        viewport: item.viewport,
        buffer: Buffer.from(buffer),
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
