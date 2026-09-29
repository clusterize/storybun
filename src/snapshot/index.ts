import { join } from "path";
import { mkdir } from "node:fs/promises";
import { loadConfig } from "../config.ts";
import { scanStories } from "../scanner.ts";
import { buildSnapshotEntry } from "./entry.ts";
import { startSnapshotServer } from "./server.ts";
import { captureAll } from "./capture.ts";
import { compareAll, updateBaselines } from "./compare.ts";
import { printReport, printUpdateReport, printFailures, getExitCode } from "./report.ts";
import { updateCodeowners } from "./codeowners.ts";
import { loadPlaywright } from "./playwright.ts";
import { buildReport, findRemovedBaselines } from "./report-model.ts";
import { loadReportTemplate } from "./report-html.tsx";
import { resolveReportPath, writeHtmlReport, writeJsonReport } from "./report-files.ts";

interface SnapshotOptions {
  update: boolean;
  filter?: string;
  codeowners: boolean;
  /** `--json [path]`: true for the default `<outDir>/report.json`. */
  json?: string | true;
  /** `--html [path]`: true for the default `<outDir>/report.html`. */
  html?: string | true;
}

export async function runSnapshots(
  cwd: string,
  options: SnapshotOptions,
): Promise<number> {
  const playwright = await loadPlaywright();
  if (!playwright) return 2;

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
      const { captures, failures } = await captureAll(
        browser,
        stories,
        resolvedSnapshotConfig,
        serverUrl,
        options.filter,
      );

      if (captures.length === 0 && failures.length === 0) {
        console.log("No stories matched the filter.");
        return 0;
      }

      let compared: Awaited<ReturnType<typeof compareAll>> | null = null;
      if (options.update) {
        const count = await updateBaselines(captures);
        printUpdateReport(count);
        exitCode = 0;
      } else {
        compared = await compareAll(captures, snapshotConfig.threshold);
        printReport(compared);
        exitCode = getExitCode(compared);
      }

      // The stories that rendered are compared and written above regardless;
      // a story that could not be captured still fails the run, after the
      // report, so nothing about it is mistaken for a pass.
      if (failures.length > 0) {
        printFailures(failures);
        exitCode = 1;
      }

      if (options.json !== undefined || options.html !== undefined) {
        // A filtered run skips stories on purpose, so a baseline it did not
        // touch is not a removed one.
        const removed = options.filter
          ? []
          : await findRemovedBaselines(
              outDir,
              [...captures, ...failures].map((c) => c.outputPath),
            );
        const report = await buildReport({
          captures,
          compared,
          failures,
          removed,
          config: resolvedSnapshotConfig,
          outDirName: snapshotConfig.outDir,
          exitCode,
          commit: process.env.GITHUB_SHA ?? null,
        });

        if (options.json !== undefined) {
          const path = resolveReportPath(options.json, cwd, outDir, "report.json");
          await writeJsonReport(path, report);
          console.log(`JSON report: ${path}`);
        }
        if (options.html !== undefined) {
          const path = resolveReportPath(options.html, cwd, outDir, "report.html");
          const template = snapshotConfig.report.component
            ? await loadReportTemplate(cwd, snapshotConfig.report.component)
            : undefined;
          await writeHtmlReport(path, report, outDir, template);
          console.log(`HTML report: ${path}`);
        }
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
