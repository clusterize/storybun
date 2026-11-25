import { basename, join } from "path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { loadConfig } from "../config.ts";
import { scanStories } from "../scanner.ts";
import { buildSnapshotEntry } from "./entry.ts";
import { startSnapshotServer } from "./server.ts";
import { captureAll } from "./capture.ts";
import { assertRendered } from "./floor.ts";
import { compareCapture, describeCompareOutcome, pruneBaselines, updateBaseline, type CompareResult } from "./compare.ts";
import { printReport, printUpdateReport, printFailures, printPruned, getExitCode } from "./report.ts";
import { updateCodeowners } from "./codeowners.ts";
import { loadPlaywright } from "./playwright.ts";
import { buildReport, findRemovedBaselines, type ReportImages } from "./report-model.ts";
import { loadReportTemplate } from "./report-html.tsx";
import { resolveReportPath, writeHtmlReport, writeJsonReport } from "./report-files.ts";
import { formatDuration, formatPlan, formatProgress } from "./progress.ts";
import { captureFingerprint, fingerprintStories, readManifest, writeManifest, type Manifest } from "./fingerprint.ts";

interface SnapshotOptions {
  update: boolean;
  /** `--all`: capture every story, also those unchanged since their baseline. */
  all?: boolean;
  filter?: string;
  codeowners: boolean;
  /** `--json [path]`: true for the default `<outDir>/report.json`. */
  json?: string | true;
  /** `--html [path]`: true for the default `<outDir>/report.html`. */
  html?: string | true;
  /** `--quiet`: no per-capture progress lines, only phases and the summary. */
  quiet?: boolean;
  /** `--report-images`: which entries' images the reports expect to be published. */
  reportImages?: ReportImages;
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

      // What each capture would be rendered from, hashed. A capture whose
      // fingerprint is the one recorded with its baseline renders the same
      // image again, so it is left out of the run unless `--all` asks for it.
      const recorded = await readManifest(outDir);
      const storyFingerprints = await timed("Fingerprinted stories", () =>
        fingerprintStories({
          graph: buildResult.graph,
          outputDir: buildResult.buildDir,
          loaded: buildResult.loaded,
          stories,
          config: snapshotConfig,
          browserVersion: browser.version(),
        }),
      );
      const planned = new Map<string, string>();
      const due = new Set<string>();

      // Each capture is compared (or, on `--update`, written) by the worker
      // that took it, as soon as it exists: no separate pass afterwards, and
      // no PNG held in memory past its own comparison.
      const compared: CompareResult[] = [];
      const outcome = await timed(
        options.update ? "Captured and updated" : "Captured and compared",
        () =>
          captureAll(browser, stories, resolvedSnapshotConfig, serverUrl, options.filter, {
            onStart: async (total, skipped) => {
              // Before the first baseline can be rewritten, the captures
              // that are due lose their recorded fingerprint. A run that is
              // killed halfway then leaves no entry vouching for an image
              // it replaced.
              const pending: Manifest = {};
              for (const [name, fingerprint] of Object.entries(recorded)) {
                if (!due.has(name)) pending[name] = fingerprint;
              }
              await writeManifest(outDir, pending);
              console.log(
                formatPlan(
                  stories.length,
                  exportCount,
                  snapshotConfig.viewports.length,
                  Object.keys(snapshotConfig.modes).length,
                  total,
                  Math.min(snapshotConfig.concurrency, total || 1),
                  skipped,
                ) + (options.filter ? ` (filter: ${options.filter})` : ""),
              );
            },
            onCapture: async (capture) => {
              // Before either path: a blank capture fails here, so it is
              // neither compared nor written as a baseline.
              assertRendered(capture, snapshotConfig);
              if (options.update) {
                await updateBaseline(capture);
                return;
              }
              const result = await compareCapture(
                capture,
                snapshotConfig.threshold,
                snapshotConfig.maxDiffPixels,
              );
              compared.push(result);
              return describeCompareOutcome(result);
            },
            onProgress: (event) => {
              // A failure is always worth a line; the rest only when asked.
              if (!options.quiet || event.error) console.log(formatProgress(event, singleViewport));
            },
          }, {
            select: (capture) => {
              const name = basename(capture.outputPath);
              const fingerprint = captureFingerprint(
                storyFingerprints.get(capture.story.filePath)!,
                capture.viewport,
                capture.mode,
              );
              planned.set(name, fingerprint);
              // A fingerprint without its baseline says nothing: the image
              // it vouched for is gone.
              const selected =
                options.all === true || recorded[name] !== fingerprint || !existsSync(capture.outputPath);
              if (selected) due.add(name);
              return selected;
            },
          }),
      );
      const { captures, failures, skipped } = outcome;

      if (captures.length === 0 && failures.length === 0 && skipped.length === 0) {
        console.log("No stories matched the filter.");
        return 0;
      }

      if (options.update) {
        printUpdateReport(captures.length, skipped.length);
        exitCode = 0;
      } else {
        printReport(compared, skipped.length);
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
            [...captures, ...failures, ...skipped].map((c) => c.outputPath),
          );
      const prune = options.update && !options.filter && removed.length > 0;

      if (options.json !== undefined || options.html !== undefined) {
        const report = await buildReport({
          captures,
          compared: options.update ? null : compared,
          failures,
          unchanged: skipped.length,
          removed,
          pruned: prune,
          config: resolvedSnapshotConfig,
          outDirName: snapshotConfig.outDir,
          exitCode,
          commit: process.env.GITHUB_SHA ?? null,
          images: options.reportImages,
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

      // Record what each baseline now stands for. A baseline that was
      // written, or that this run's render matched, gets the fingerprint of
      // that render. One that this run's render did not match loses its
      // fingerprint: nothing vouches for it until it is accepted, so every
      // run captures it, also when the mismatch was found by `--all` with
      // nothing edited. One that could not be captured keeps what it had.
      // Entries of stories that are gone are dropped, except under a filter,
      // which says nothing about the stories it left out.
      const manifest: Manifest = {};
      for (const [name, fingerprint] of Object.entries(recorded)) {
        if (options.filter || planned.has(name)) manifest[name] = fingerprint;
      }
      if (options.update) {
        for (const c of captures) manifest[basename(c.outputPath)] = planned.get(basename(c.outputPath))!;
      } else {
        for (const r of compared) {
          const name = basename(r.outputPath);
          if (r.status === "fail") delete manifest[name];
          else manifest[name] = planned.get(name)!;
        }
      }
      await writeManifest(outDir, manifest);

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
