// Reads report.json and exposes its summary as step outputs and as the job
// summary. Env: REPORT_PATH. Writes GITHUB_OUTPUT and GITHUB_STEP_SUMMARY.
import { appendFile } from "node:fs/promises";
import type { SnapshotReport } from "../src/snapshot/report-model.ts";
import { buildStepSummary, needsReview } from "./report-comment.ts";

const reportPath = process.env.REPORT_PATH;
if (!reportPath) throw new Error("REPORT_PATH is not set");
const report = (await Bun.file(reportPath).json()) as SnapshotReport;
const s = report.summary;

const outputs: Record<string, string> = {
  "needs-review": String(needsReview(report)),
  summary: JSON.stringify(s),
  passed: String(s.passed),
  changed: String(s.changed),
  new: String(s.new),
  removed: String(s.removed),
  "capture-failed": String(s.captureFailed),
  updated: String(s.updated),
};

if (process.env.GITHUB_OUTPUT) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    Object.entries(outputs)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(""),
  );
}
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, buildStepSummary(report, process.env.REPORT_URL));
}
console.log(`storybun: ${outputs.summary}`);
