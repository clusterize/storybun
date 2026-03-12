import type { CompareResult } from "./compare.ts";

export function printReport(results: CompareResult[]): void {
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

  if (failed.length > 0) {
    console.log("\nChanged:");
    for (const r of failed) {
      console.log(`  ${r.storyKey} (${r.diffPercent.toFixed(1)}% diff)`);
    }
    console.log("\nRun with --update to accept changes.");
  }

  if (newCount > 0 && failed.length === 0) {
    console.log("\nNew baselines saved.");
  }

  console.log();
}

export function printUpdateReport(count: number): void {
  console.log(`\nstorybun snapshot: updated ${count} baseline(s)\n`);
}

export function getExitCode(results: CompareResult[]): number {
  return results.some((r) => r.status === "fail") ? 1 : 0;
}
