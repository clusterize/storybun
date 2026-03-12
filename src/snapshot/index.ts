import { join } from "path";
import { mkdir } from "node:fs/promises";
import { loadConfig } from "../config.ts";
import { scanStories } from "../scanner.ts";
import { buildSnapshotEntry } from "./entry.ts";
import { startSnapshotServer } from "./server.ts";
import { captureAll } from "./capture.ts";
import { compareAll, updateBaselines } from "./compare.ts";
import { printReport, printUpdateReport, getExitCode } from "./report.ts";
import { updateCodeowners } from "./codeowners.ts";

interface SnapshotOptions {
  update: boolean;
  filter?: string;
  codeowners: boolean;
}

export async function runSnapshots(
  cwd: string,
  options: SnapshotOptions,
): Promise<number> {
  // Check for Playwright
  let playwright: typeof import("playwright");
  try {
    playwright = await import("playwright");
  } catch {
    console.error(
      "Playwright is required for snapshots but not installed.\n" +
        "Install it with:\n\n" +
        "  bun add -d playwright\n" +
        "  bunx playwright install chromium\n",
    );
    return 2;
  }

  const config = await loadConfig(cwd);
  const snapshotConfig = config.snapshot;
  const outDir = join(cwd, snapshotConfig.outDir);

  // Ensure output directory exists
  await mkdir(outDir, { recursive: true });

  // Resolve outDir in snapshot config to absolute path for capture
  const resolvedSnapshotConfig = { ...snapshotConfig, outDir };

  console.log("Scanning stories...");
  const { stories, packages } = await scanStories(config, cwd);
  console.log(`Found ${stories.length} story file(s)`);

  if (stories.length === 0) {
    console.log("No stories found.");
    return 0;
  }

  console.log("Building snapshot entry...");
  const buildResult = await buildSnapshotEntry(stories, packages, config, cwd);

  const server = startSnapshotServer(buildResult);
  const serverUrl = `http://localhost:${server.port}`;
  console.log(`Snapshot server on ${serverUrl}`);

  let exitCode = 0;

  try {
    console.log("Launching browser...");
    const browser = await playwright.chromium.launch();

    try {
      console.log("Capturing snapshots...");
      const captures = await captureAll(
        browser,
        stories,
        resolvedSnapshotConfig,
        serverUrl,
        options.filter,
      );

      if (captures.length === 0) {
        console.log("No stories matched the filter.");
        return 0;
      }

      if (options.update) {
        const count = await updateBaselines(captures);
        printUpdateReport(count);
        exitCode = 0;
      } else {
        const results = await compareAll(captures, snapshotConfig.threshold);
        printReport(results);
        exitCode = getExitCode(results);
      }

      if (options.codeowners) {
        await updateCodeowners(cwd, snapshotConfig.outDir, snapshotConfig.codeowners);
      }
    } finally {
      await browser.close();
    }
  } finally {
    server.stop();
  }

  return exitCode;
}
