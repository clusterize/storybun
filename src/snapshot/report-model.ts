import { readdir } from "node:fs/promises";
import { basename, join } from "path";
import type { ResolvedSnapshotConfig } from "../types.ts";
import type { CaptureFailure, CaptureResult } from "./capture.ts";
import type { CompareResult } from "./compare.ts";

/**
 * The machine-readable twin of the stdout report. Written as `report.json`
 * and handed to the HTML template; the shape is the contract a consumer
 * (a CI comment script, a custom template) relies on, so a change to it
 * bumps `version`.
 */
export const REPORT_VERSION = 1;

export type ReportStatus =
  /** Pixel-identical to the baseline. */
  | "pass"
  /** Differs from the baseline, in pixels or in dimensions. */
  | "changed"
  /** No baseline existed; this run's render was adopted as the baseline. */
  | "new"
  /** A baseline in `outDir` that no story of this run produced anymore. */
  | "removed"
  /** The story could not be captured; nothing was compared or written. */
  | "capture-failed"
  /** `--update`: this run's render replaced the baseline. */
  | "updated";

export interface ReportViewport {
  width: number;
  height: number;
  name?: string;
}

export interface ReportDimensions {
  width: number;
  height: number;
}

export interface ReportEntry {
  /** `<story path>--<export>`; for a removed baseline, the filename stem. */
  storyKey: string;
  mode: string | null;
  viewport: ReportViewport | null;
  status: ReportStatus;
  /** Percentage of differing pixels; null when nothing was compared. */
  diffPercent: number | null;
  dimensions: {
    baseline: ReportDimensions | null;
    actual: ReportDimensions | null;
  };
  /** Paths relative to `outDir`. Only a file that exists after this run is listed. */
  files: {
    baseline: string | null;
    actual: string | null;
    diff: string | null;
  };
  /** First line of the capture error; only for `capture-failed`. */
  error: string | null;
}

export interface ReportSummary {
  total: number;
  passed: number;
  changed: number;
  new: number;
  removed: number;
  captureFailed: number;
  updated: number;
  /** The exit code of the run this report describes. */
  exitCode: number;
}

export interface ReportConfig {
  threshold: number;
  maxDiffPixels: number;
  viewports: ReportViewport[];
  modes: string[];
  clock: string | null;
  locale: string;
  timezoneId: string;
}

export interface SnapshotReport {
  version: typeof REPORT_VERSION;
  generatedAt: string;
  /** The snapshot directory as configured, relative to the project root. */
  outDir: string;
  /** Short or full commit SHA when known (`GITHUB_SHA`), else null. */
  commit: string | null;
  summary: ReportSummary;
  config: ReportConfig;
  results: ReportEntry[];
}

export interface BuildReportInput {
  captures: CaptureResult[];
  /** Comparison results, or null on an `--update` run. */
  compared: CompareResult[] | null;
  failures: CaptureFailure[];
  /** Absolute paths of baselines no story produced; see `findRemovedBaselines`. */
  removed: string[];
  /**
   * True when the run deletes the removed baselines after this report is
   * built (`--update`): their entries then list no file, since none exists
   * once the run is over.
   */
  pruned?: boolean;
  /** The snapshot config with `outDir` resolved to an absolute path. */
  config: ResolvedSnapshotConfig;
  /** `outDir` as configured, for the JSON. */
  outDirName: string;
  exitCode: number;
  commit?: string | null;
  now?: Date;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from a PNG's IHDR chunk, without decoding the image. */
export function pngDimensions(buffer: Buffer): ReportDimensions | null {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function fileDimensions(path: string): Promise<ReportDimensions | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return pngDimensions(Buffer.from(await file.slice(0, 24).arrayBuffer()));
}

function toActualPath(pngPath: string): string {
  return pngPath.replace(/\.png$/, ".actual.png");
}

function toDiffPath(pngPath: string): string {
  return pngPath.replace(/\.png$/, ".diff.png");
}

function sameDimensions(a: ReportDimensions | null, b: ReportDimensions | null): boolean {
  return a !== null && b !== null && a.width === b.width && a.height === b.height;
}

function compareEntries(a: ReportEntry, b: ReportEntry): number {
  if (a.storyKey !== b.storyKey) return a.storyKey < b.storyKey ? -1 : 1;
  const am = a.mode ?? "";
  const bm = b.mode ?? "";
  if (am !== bm) return am < bm ? -1 : 1;
  const aw = a.viewport?.width ?? 0;
  const bw = b.viewport?.width ?? 0;
  if (aw !== bw) return aw - bw;
  return (a.viewport?.height ?? 0) - (b.viewport?.height ?? 0);
}

/**
 * Baselines in `outDir` that this run did not produce: `<key>.png` files that
 * are neither an `.actual.png` nor a `.diff.png` and are not the output path
 * of any capture or capture failure. Meaningless under `--filter`, where the
 * run deliberately skips stories; the caller passes an empty list then.
 */
export async function findRemovedBaselines(
  outDir: string,
  producedPaths: Iterable<string>,
): Promise<string[]> {
  const produced = new Set<string>();
  for (const p of producedPaths) produced.add(basename(p));

  let names: string[];
  try {
    names = await readdir(outDir);
  } catch {
    return [];
  }

  return names
    .filter(
      (name) =>
        name.endsWith(".png") &&
        !name.endsWith(".actual.png") &&
        !name.endsWith(".diff.png") &&
        !produced.has(name),
    )
    .sort()
    .map((name) => join(outDir, name));
}

export async function buildReport(input: BuildReportInput): Promise<SnapshotReport> {
  const { config } = input;
  const entries: ReportEntry[] = [];

  const comparedByPath = new Map<string, CompareResult>();
  for (const r of input.compared ?? []) comparedByPath.set(r.outputPath, r);

  for (const capture of input.captures) {
    const baselineFile = basename(capture.outputPath);
    const actualDims = pngDimensions(capture.buffer);
    const base = {
      storyKey: capture.storyKey,
      mode: capture.mode ?? null,
      viewport: capture.viewport,
      error: null,
    };

    if (input.compared === null) {
      entries.push({
        ...base,
        status: "updated",
        diffPercent: null,
        dimensions: { baseline: actualDims, actual: null },
        files: { baseline: baselineFile, actual: null, diff: null },
      });
      continue;
    }

    const compared = comparedByPath.get(capture.outputPath);
    if (!compared) {
      throw new Error(`No comparison result for ${capture.storyKey} (${capture.outputPath})`);
    }

    if (compared.status === "new") {
      // The freshly written baseline is this story's "after" image; no
      // `.actual.png` exists for it and none is invented here.
      entries.push({
        ...base,
        status: "new",
        diffPercent: null,
        dimensions: { baseline: actualDims, actual: null },
        files: { baseline: baselineFile, actual: null, diff: null },
      });
      continue;
    }

    // A pass may still carry a diffPercent above zero: the difference stayed
    // within `maxDiffPixels`, so no actual or diff image was kept.
    if (compared.status === "pass") {
      entries.push({
        ...base,
        status: "pass",
        diffPercent: compared.diffPercent,
        dimensions: { baseline: actualDims, actual: actualDims },
        files: { baseline: baselineFile, actual: null, diff: null },
      });
      continue;
    }

    // "fail": the baseline is still the old image on disk, the actual was
    // written next to it. A diff image exists only when both have the same
    // dimensions; on a mismatch pixelmatch never ran, and a stale diff from an
    // earlier run must not be presented as this run's.
    const baselineDims = await fileDimensions(capture.outputPath);
    const hasDiff = sameDimensions(baselineDims, actualDims);
    entries.push({
      ...base,
      status: "changed",
      diffPercent: compared.diffPercent,
      dimensions: { baseline: baselineDims, actual: actualDims },
      files: {
        baseline: baselineFile,
        actual: basename(toActualPath(capture.outputPath)),
        diff: hasDiff ? basename(toDiffPath(capture.outputPath)) : null,
      },
    });
  }

  for (const failure of input.failures) {
    entries.push({
      storyKey: failure.storyKey,
      mode: failure.mode ?? null,
      viewport: failure.viewport,
      status: "capture-failed",
      diffPercent: null,
      dimensions: { baseline: null, actual: null },
      files: { baseline: null, actual: null, diff: null },
      error: failure.error.message.split("\n")[0] ?? String(failure.error),
    });
  }

  for (const path of input.removed) {
    const file = basename(path);
    entries.push({
      storyKey: file.replace(/\.png$/, ""),
      mode: null,
      viewport: null,
      status: "removed",
      diffPercent: null,
      dimensions: { baseline: await fileDimensions(path), actual: null },
      files: { baseline: input.pruned ? null : file, actual: null, diff: null },
      error: null,
    });
  }

  entries.sort(compareEntries);

  const summary: ReportSummary = {
    total: entries.length,
    passed: 0,
    changed: 0,
    new: 0,
    removed: 0,
    captureFailed: 0,
    updated: 0,
    exitCode: input.exitCode,
  };
  for (const e of entries) {
    if (e.status === "pass") summary.passed++;
    else if (e.status === "changed") summary.changed++;
    else if (e.status === "new") summary.new++;
    else if (e.status === "removed") summary.removed++;
    else if (e.status === "capture-failed") summary.captureFailed++;
    else if (e.status === "updated") summary.updated++;
  }

  return {
    version: REPORT_VERSION,
    generatedAt: (input.now ?? new Date()).toISOString(),
    outDir: input.outDirName,
    commit: input.commit ?? null,
    summary,
    config: {
      threshold: config.threshold,
      maxDiffPixels: config.maxDiffPixels,
      viewports: config.viewports,
      modes: Object.keys(config.modes),
      clock: config.clock,
      locale: config.locale,
      timezoneId: config.timezoneId,
    },
    results: entries,
  };
}
