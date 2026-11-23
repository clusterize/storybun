import { PNG } from "pngjs";
import type { ResolvedSnapshotConfig } from "../types.ts";
import type { CaptureResult } from "./capture.ts";

/**
 * Distinct RGB values in a PNG, counted exactly and unquantised.
 *
 * Colour count is the one cheap signal that separates a story which painted
 * nothing from one which painted little. Byte size does not: a 40px spinner
 * compresses to fewer bytes than an empty bordered card with a drop shadow, so
 * any byte floor that catches the second rejects the first. Nor does the share
 * of non-background pixels: that same card covers far more of the viewport in
 * shadow than the spinner does.
 *
 * Counting stops as soon as `stopAt` is reached, so a normal render walks only
 * far enough to prove itself rather than tallying every colour in the image.
 */
export function countColors(buffer: Buffer, stopAt = Infinity): number {
  const { data } = PNG.sync.read(buffer);
  const colors = new Set<number>();
  for (let i = 0; i < data.length; i += 4) {
    colors.add((data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!);
    if (colors.size >= stopAt) break;
  }
  return colors.size;
}

/** A capture with too few colours to be a render of anything. */
export class BlankCaptureError extends Error {
  constructor(
    readonly colors: number,
    readonly minColors: number,
  ) {
    const found = colors === 1 ? "1 colour" : `${colors} colours`;
    super(
      `rendered nothing (${found}, below the snapshot.minColors floor of ${minColors}); ` +
        "not compared and not written",
    );
    this.name = "BlankCaptureError";
  }
}

/**
 * Throws `BlankCaptureError` for a capture below the `minColors` floor.
 *
 * A blank capture has to fail loudly rather than merge, because a capture is
 * only ever judged against the previous baseline: once a blank render is
 * accepted as the baseline it agrees with itself forever, and the story reports
 * green while covering nothing. Thrown from the capture hook, it fails that one
 * capture -- before it is compared or written, on `--update` too -- and the run
 * goes on with the others.
 */
export function assertRendered(capture: CaptureResult, config: ResolvedSnapshotConfig): void {
  if (config.minColors <= 0) return;
  if (config.minColorsIgnore.some((pattern) => capture.storyKey.includes(pattern))) return;
  const colors = countColors(capture.buffer, config.minColors);
  if (colors < config.minColors) throw new BlankCaptureError(colors, config.minColors);
}
