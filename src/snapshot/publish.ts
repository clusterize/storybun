// Which images a published report needs. Type imports only: the action's
// scripts import this file from the checked-out action, which has no
// node_modules.
import type { ReportEntry, ReportStatus, SnapshotReport } from "./report-model.ts";

/** Statuses whose images a reviewer needs; the same ones the HTML report puts above the fold. */
const REVIEW_STATUSES: ReadonlySet<ReportStatus> = new Set(["changed", "new", "removed", "capture-failed"]);

/**
 * Whether the report's images for this entry are published with it. Under
 * `review`, a passed or updated capture's image is identical to (or is) the
 * baseline, which nobody reviewing a change needs; uploading thousands of them
 * is what made publishing slow.
 */
export function imagesPublished(report: Pick<SnapshotReport, "images">, entry: Pick<ReportEntry, "status">): boolean {
  return report.images !== "review" || REVIEW_STATUSES.has(entry.status);
}

/**
 * The image files, relative to `outDir`, that a publisher uploads next to the
 * report so that every image `report.html` shows resolves. Each file once, in
 * report order. A capture failure lists no file, and neither does a removed
 * baseline pruned by `--update`.
 */
export function filesToPublish(report: SnapshotReport): string[] {
  const files = new Set<string>();
  for (const entry of report.results) {
    if (!imagesPublished(report, entry)) continue;
    for (const file of [entry.files.baseline, entry.files.actual, entry.files.diff]) {
      if (file) files.add(file);
    }
  }
  return [...files];
}
