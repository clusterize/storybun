import { unlink } from "node:fs/promises";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import type { CaptureResult } from "./capture.ts";

async function removeIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {}
}

function toActualPath(pngPath: string): string {
  return pngPath.replace(/\.png$/, ".actual.png");
}

function toDiffPath(pngPath: string): string {
  return pngPath.replace(/\.png$/, ".diff.png");
}

export type CompareStatus = "pass" | "fail" | "new";

export interface CompareResult {
  storyKey: string;
  mode?: string;
  status: CompareStatus;
  /**
   * Share of pixels that differ from the baseline, 0 to 100. Non-zero on a
   * pass only when the difference stayed within `maxDiffPixels`.
   */
  diffPercent: number;
  outputPath: string;
}

/**
 * Compare one capture against its baseline on disk, writing the baseline
 * when there is none and the actual/diff images when it changed. `threshold`
 * is pixelmatch's per-pixel colour sensitivity; `maxDiffPixels` is how many
 * pixels may differ before the story counts as changed. A story within that
 * budget passes and leaves no actual/diff image behind, so a stray edge pixel
 * on one CI machine does not read as a change.
 *
 * Called from the capture worker as each screenshot lands (see
 * `CaptureHooks.onCapture`), so the comparison overlaps with the next render
 * and the PNG can be dropped right after.
 */
export async function compareCapture(
  capture: CaptureResult,
  threshold: number,
  maxDiffPixels = 0,
): Promise<CompareResult> {
  const baselinePath = capture.outputPath;
  const baselineFile = Bun.file(baselinePath);

  const actualPath = toActualPath(capture.outputPath);
  const diffPath = toDiffPath(capture.outputPath);

  if (!(await baselineFile.exists())) {
    // New snapshot — save it as baseline
    await Bun.write(baselinePath, capture.buffer);
    await removeIfExists(actualPath);
    await removeIfExists(diffPath);
    return {
      storyKey: capture.storyKey,
      mode: capture.mode,
      status: "new",
      diffPercent: 0,
      outputPath: capture.outputPath,
    };
  }

  const baselineBuffer = Buffer.from(await baselineFile.arrayBuffer());
  const baseline = PNG.sync.read(baselineBuffer);
  const actual = PNG.sync.read(capture.buffer);

  // Handle size mismatches as a fail
  if (baseline.width !== actual.width || baseline.height !== actual.height) {
    await Bun.write(actualPath, capture.buffer);
    return {
      storyKey: capture.storyKey,
      mode: capture.mode,
      status: "fail",
      diffPercent: 100,
      outputPath: capture.outputPath,
    };
  }

  const { width, height } = baseline;
  const diff = new PNG({ width, height });
  const numDiffPixels = pixelmatch(
    baseline.data,
    actual.data,
    diff.data,
    width,
    height,
    { threshold },
  );

  const totalPixels = width * height;
  const diffPercent = totalPixels > 0 ? (numDiffPixels / totalPixels) * 100 : 0;

  if (numDiffPixels <= maxDiffPixels) {
    await removeIfExists(actualPath);
    await removeIfExists(diffPath);
    return {
      storyKey: capture.storyKey,
      mode: capture.mode,
      status: "pass",
      diffPercent,
      outputPath: capture.outputPath,
    };
  }

  // Save actual and diff images alongside baseline
  await Bun.write(actualPath, capture.buffer);
  await Bun.write(diffPath, PNG.sync.write(diff));

  return {
    storyKey: capture.storyKey,
    mode: capture.mode,
    status: "fail",
    diffPercent,
    outputPath: capture.outputPath,
  };
}

/** `compareCapture` over a list, in order. */
export async function compareAll(
  captures: CaptureResult[],
  threshold: number,
  maxDiffPixels = 0,
): Promise<CompareResult[]> {
  const results: CompareResult[] = [];
  for (const capture of captures) {
    results.push(await compareCapture(capture, threshold, maxDiffPixels));
  }
  return results;
}

/** What the progress line says about a comparison; a plain pass says nothing. */
export function describeCompareOutcome(result: CompareResult): string | undefined {
  if (result.status === "new") return "+ new";
  if (result.status === "fail") return `changed ${result.diffPercent.toFixed(1)}%`;
  return undefined;
}

/**
 * Deletes baselines no story produces anymore, together with any stale
 * `.actual.png` / `.diff.png` next to them. Only `--update` calls this, and
 * only without `--filter`: a filtered run skips stories on purpose, and a
 * story that failed to capture still counts as present, so a flaky capture
 * never drops a baseline. Returns the number of baselines deleted.
 */
export async function pruneBaselines(paths: string[]): Promise<number> {
  for (const path of paths) {
    await removeIfExists(path);
    await removeIfExists(toActualPath(path));
    await removeIfExists(toDiffPath(path));
  }
  return paths.length;
}

/** Write the capture as its baseline, clearing stale diff artifacts from previous runs. */
export async function updateBaseline(capture: CaptureResult): Promise<void> {
  await Bun.write(capture.outputPath, capture.buffer);
  await removeIfExists(toActualPath(capture.outputPath));
  await removeIfExists(toDiffPath(capture.outputPath));
}

export async function updateBaselines(
  captures: CaptureResult[],
): Promise<number> {
  for (const capture of captures) {
    await updateBaseline(capture);
  }
  return captures.length;
}
