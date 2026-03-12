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
  status: CompareStatus;
  diffPercent: number;
  outputPath: string;
}

export async function compareAll(
  captures: CaptureResult[],
  threshold: number,
): Promise<CompareResult[]> {
  const results: CompareResult[] = [];

  for (const capture of captures) {
    const baselinePath = capture.outputPath;
    const baselineFile = Bun.file(baselinePath);

    const actualPath = toActualPath(capture.outputPath);
    const diffPath = toDiffPath(capture.outputPath);

    if (!(await baselineFile.exists())) {
      // New snapshot — save it as baseline
      await Bun.write(baselinePath, capture.buffer);
      await removeIfExists(actualPath);
      await removeIfExists(diffPath);
      results.push({
        storyKey: capture.storyKey,
        status: "new",
        diffPercent: 0,
        outputPath: capture.outputPath,
      });
      continue;
    }

    const baselineBuffer = Buffer.from(await baselineFile.arrayBuffer());
    const baseline = PNG.sync.read(baselineBuffer);
    const actual = PNG.sync.read(capture.buffer);

    // Handle size mismatches as a fail
    if (baseline.width !== actual.width || baseline.height !== actual.height) {
      await Bun.write(actualPath, capture.buffer);
      results.push({
        storyKey: capture.storyKey,
        status: "fail",
        diffPercent: 100,
        outputPath: capture.outputPath,
      });
      continue;
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

    if (numDiffPixels === 0) {
      await removeIfExists(actualPath);
      await removeIfExists(diffPath);
      results.push({
        storyKey: capture.storyKey,
        status: "pass",
        diffPercent: 0,
        outputPath: capture.outputPath,
      });
    } else {
      // Save actual and diff images alongside baseline
      await Bun.write(actualPath, capture.buffer);
      await Bun.write(diffPath, PNG.sync.write(diff));

      results.push({
        storyKey: capture.storyKey,
        status: "fail",
        diffPercent,
        outputPath: capture.outputPath,
      });
    }
  }

  return results;
}

export async function updateBaselines(
  captures: CaptureResult[],
): Promise<number> {
  for (const capture of captures) {
    await Bun.write(capture.outputPath, capture.buffer);
    // Clean up stale diff artifacts from previous runs
    await removeIfExists(toActualPath(capture.outputPath));
    await removeIfExists(toDiffPath(capture.outputPath));
  }
  return captures.length;
}
