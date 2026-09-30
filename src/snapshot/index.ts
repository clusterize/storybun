import { join } from "path";
import { mkdir } from "node:fs/promises";
import { loadConfig } from "../config.ts";
import { scanStories } from "../scanner.ts";
import { buildSnapshotEntry } from "./entry.ts";
import { startSnapshotServer } from "./server.ts";
import { captureAll } from "./capture.ts";
import { compareAll, pruneBaselines, updateBaselines } from "./compare.ts";
import { printReport, printUpdateReport, printFailures, printPruned, getExitCode } from "./report.ts";
import { updateCodeowners } from "./codeowners.ts";
import { loadPlaywright } from "./playwright.ts";
import { buildReport, findRemovedBaselines } from "./report-model.ts";
import { loadReportTemplate } from "./report-html.tsx";
import { resolveReportPath, writeHtmlReport, writeJsonReport } from "./report-files.ts";
import { formatDuration, formatPlan, formatProgress } from "./progress.ts";

interface SnapshotOptions {
  update: boolean;
  filter?: string;
  codeowners: boolean;
  /** `--json [path]`: true for the default `<outDir>/report.json`. */
  json?: string | true;
  /** `--html [path]`: true for the default `<outDir>/report.html`. */
  html?: string | true;
  /** `--quiet`: no per-capture progress lines, only phases and the summary. */
  quiet?: boolean;
}

/** Logs `<label> in <duration>` once the awaited work is done. */
async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  const result = await work();
  console.log(`${label} in ${formatDuration(performance.now() - startedAt)}`);
  return result;
}

export async function runSnapshots(
  cwd: string,
  options: SnapshotOptions,
): Promise<number> {
  const runStartedAt = performance.now();
  const playwright = await loadPlaywright();
  if (!playwright) return 2;

  const config = await loadConfig(cwd);
  const snapshotConfig = config.snapshot;
  const outDir = join(cwd, snapshotConfig.outDir);

  // Ensure output directory exists
  await mkdir(outDir, { recursive: true });

  // Resolve outDir in snapshot config to absolute path for capture
  const resolvedSnapshotConfig = { ...snapshotConfig, outDir };

  const { stories, packages } = await timed("Scanned stories", () => scanStories(config, cwd));
  console.log(
    `Found ${stories.length} story file(s) in ${packages.size} package(s), baselines in ${snapshotConfig.outDir}`,
  );

  if (stories.length === 0) {
    console.log("No stories found.");
    return 0;
  }

  const buildResult = await timed("Built snapshot entry", () =>
    buildSnapshotEntry(stories, packages, config, cwd),
  );

  const server = startSnapshotServer(buildResult);
  const serverUrl = `http://localhost:${server.port}`;
  console.log(`Snapshot server on ${serverUrl}`);

  let exitCode = 0;

  try {
    const browser = await timed("Launched browser", () => playwright.chromium.launch());

    try {
      const singleViewport = snapshotConfig.viewports.length === 1;
      const exportCount = stories.reduce((n, s) => n + s.exports.length, 0);
      const { captures, failures } = await timed("Captured", () =>
        captureAll(browser, stories, resolvedSnapshotConfig, serverUrl, options.filter, {
          onStart: (total) => {
            console.log(
              formatPlan(
                stories.length,
                exportCount,
                snapshotConfig.viewports.length,
                Object.keys(snapshotConfig.modes).length,
                total,
                Math.min(snapshotConfig.concurrency, total || 1),
              ) + (options.filter ? ` (filter: ${options.filter})` : ""),
            );
          },
          onProgress: (event) => {
            // A failure is always worth a line; the rest only when asked.
            if (!options.quiet || event.error) console.log(formatProgress(event, singleViewport));
          },
        }),
      );

      if (captures.length === 0 && failures.length === 0) {
        console.log("No stories matched the filter.");
        return 0;
      }

      let compared: Awaited<ReturnType<typeof compareAll>> | null = null;
      if (options.update) {
        const count = await timed("Updated baselines", () => updateBaselines(captures));
        printUpdateReport(count);
        exitCode = 0;
      } else {
        compared = await timed("Compared against baselines", () =>
          compareAll(captures, snapshotConfig.threshold),
        );
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

      // A filtered run skips stories on purpose, so a baseline it did not
      // touch is not a removed one. Without a filter, an update run is the
      // one place a stale baseline can safely go: the run just rewrote every
      // baseline it could produce, and a story that failed to capture still
      // counts as present.
      const removed = options.filter
        ? []
        : await findRemovedBaselines(
            outDir,
            [...captures, ...failures].map((c) => c.outputPath),
          );
      const prune = options.update && !options.filter && removed.length > 0;

      if (options.json !== undefined || options.html !== undefined) {
        const report = await buildReport({
          captures,
          compared,
          failures,
          removed,
          pruned: prune,
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

      // After the report, which still measured the files.
      if (prune) {
        await pruneBaselines(removed);
        printPruned(removed);
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

  console.log(`Done in ${formatDuration(performance.now() - runStartedAt)} (exit code ${exitCode})`);
  return exitCode;
}
