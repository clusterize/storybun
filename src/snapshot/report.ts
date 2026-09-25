import type { CaptureFailure } from "./capture.ts";
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

export function printUpdateReport(count: number): void {
  console.log(`\nstorybun snapshot: updated ${count} baseline(s)\n`);
}

export function getExitCode(results: CompareResult[]): number {
  return results.some((r) => r.status === "fail") ? 1 : 0;
}
