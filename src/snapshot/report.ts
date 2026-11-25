import type { CaptureFailure } from "./capture.ts";
import type { CompareResult } from "./compare.ts";

function unchangedLine(count: number): string {
  return `  = ${count} unchanged since ${count === 1 ? "its" : "their"} baseline, not captured`;
}

export function printReport(results: CompareResult[], unchanged = 0): void {
  let passCount = 0;
  let newCount = 0;
  const failed: CompareResult[] = [];

  for (const r of results) {
    if (r.status === "pass") passCount++;
    else if (r.status === "new") newCount++;
    else failed.push(r);
  }

  console.log("\nstorybun snapshot:");

  if (passCount > 0) {
    console.log(`  \u2713 ${passCount} passed`);
  }
  if (failed.length > 0) {
    console.log(`  \u2717 ${failed.length} changed`);
  }
  if (newCount > 0) {
    console.log(`  + ${newCount} new`);
  }
  if (unchanged > 0) {
    console.log(unchangedLine(unchanged));
  }

  if (failed.length > 0) {
    console.log("\nChanged:");
    for (const r of failed) {
      const label = r.mode ? `${r.storyKey} [${r.mode}]` : r.storyKey;
      console.log(`  ${label} (${r.diffPercent.toFixed(1)}% diff)`);
    }
    console.log("\nRun with --update to accept changes.");
  }

  if (newCount > 0 && failed.length === 0) {
    console.log("\nNew baselines saved.");
  }

  console.log();
}

export function printFailures(failures: CaptureFailure[]): void {
  console.log(`\u2717 ${failures.length} could not be captured:`);
  for (const f of failures) {
    const label = f.mode ? `${f.storyKey} [${f.mode}]` : f.storyKey;
    console.log(`  ${label}: ${f.error.message.split("\n")[0]}`);
  }
  console.log();
}

export function printUpdateReport(count: number, unchanged = 0): void {
  console.log(`\nstorybun snapshot: updated ${count} baseline(s)`);
  if (unchanged > 0) console.log(unchangedLine(unchanged));
  console.log();
}

const PRUNE_LIST_LIMIT = 20;

export function printPruned(paths: string[]): void {
  if (paths.length === 0) return;
  console.log(`\u2212 ${paths.length} stale baseline(s) deleted (no story produces them anymore):`);
  for (const path of paths.slice(0, PRUNE_LIST_LIMIT)) {
    console.log(`  ${path.split("/").pop()}`);
  }
  if (paths.length > PRUNE_LIST_LIMIT) {
    console.log(`  +${paths.length - PRUNE_LIST_LIMIT} more`);
  }
  console.log();
}

export function getExitCode(results: CompareResult[]): number {
  return results.some((r) => r.status === "fail") ? 1 : 0;
}
