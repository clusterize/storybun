// Pure builders shared by the action's scripts. No dependencies: this file
// runs from the checked-out action, which has no node_modules.
import type { ReportEntry, SnapshotReport } from "../src/snapshot/report-model.ts";

export const COMMENT_MARKER = "<!-- storybun-report -->";

/** The most entries listed per status before "+N more". */
export const LIST_LIMIT = 10;

export function needsReview(report: SnapshotReport): boolean {
  const s = report.summary;
  return s.changed + s.new + s.removed + s.captureFailed > 0;
}

/** Markdown-inert story key: backticks are the only thing that can break the code span. */
function code(text: string): string {
  return "`" + text.replace(/`/g, "'") + "`";
}

function entryLine(entry: ReportEntry): string {
  let line = code(entry.storyKey);
  if (entry.mode) line += ` [${entry.mode}]`;
  if (entry.viewport?.name) line += ` @${entry.viewport.name}`;
  if (entry.status === "changed" && entry.diffPercent !== null) {
    line += entry.files.diff === null ? " (size changed)" : ` (${entry.diffPercent.toFixed(1)}%)`;
  }
  if (entry.status === "capture-failed" && entry.error) line += `: ${entry.error.replace(/`/g, "'")}`;
  return `- ${line}`;
}

function section(title: string, entries: ReportEntry[]): string[] {
  if (entries.length === 0) return [];
  const lines = [`**${title}** (${entries.length})`, ...entries.slice(0, LIST_LIMIT).map(entryLine)];
  if (entries.length > LIST_LIMIT) lines.push(`- +${entries.length - LIST_LIMIT} more`);
  lines.push("");
  return lines;
}

export function headline(report: SnapshotReport): string {
  const s = report.summary;
  const parts: string[] = [];
  if (s.changed) parts.push(`${s.changed} changed`);
  if (s.new) parts.push(`${s.new} new`);
  if (s.removed) parts.push(`${s.removed} removed`);
  if (s.captureFailed) parts.push(`${s.captureFailed} could not be captured`);
  if (s.updated) parts.push(`${s.updated} updated`);
  return parts.length > 0 ? parts.join(", ") : "match the baseline";
}

export function summaryTable(report: SnapshotReport): string {
  const s = report.summary;
  return [
    "| passed | changed | new | removed | capture failed |",
    "| --: | --: | --: | --: | --: |",
    `| ${s.passed} | ${s.changed} | ${s.new} | ${s.removed} | ${s.captureFailed} |`,
  ].join("\n");
}

export interface CommentOptions {
  reportUrl?: string;
  /** Text after the headline when nothing needs a look; default "at <sha>". */
  commit?: string | null;
}

/** The body of the sticky pull request comment, marker included. */
export function buildComment(report: SnapshotReport, options: CommentOptions = {}): string {
  const commit = (options.commit ?? report.commit)?.slice(0, 7);
  const at = commit ? ` at \`${commit}\`` : "";
  const lines: string[] = [COMMENT_MARKER];

  if (!needsReview(report)) {
    lines.push(`Visual snapshots ${headline(report)}${at}.`);
    return lines.join("\n");
  }

  lines.push(`### Visual snapshots: ${headline(report)}`, "", summaryTable(report), "");
  const by = (status: ReportEntry["status"]) => report.results.filter((r) => r.status === status);
  lines.push(
    ...section("Changed", by("changed")),
    ...section("New", by("new")),
    ...section("Removed", by("removed")),
    ...section("Could not be captured", by("capture-failed")),
  );
  if (options.reportUrl) {
    lines.push(`[Open the report](${options.reportUrl}) for before / after / diff of every story${at}.`);
  } else {
    lines.push(`Run \`storybun snapshot --html\` locally for before / after / diff of every story${at}.`);
  }
  return lines.join("\n");
}

/** The job summary shown on the workflow run page. */
export function buildStepSummary(report: SnapshotReport, reportUrl?: string): string {
  const lines = [`## Visual snapshots: ${headline(report)}`, "", summaryTable(report), ""];
  if (reportUrl) lines.push(`[Open the report](${reportUrl})`, "");
  return lines.join("\n");
}
