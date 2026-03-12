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
  const pages = await Promise.all(
    Array.from({ length: concurrency }, () => browser.newPage()),
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
    }
  }

  await Promise.all(pages.map(processPage));

  for (const page of pages) {
    await page.close();
  }

  return results;
}
