import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { CaptureResult } from "./capture.ts";
import { compareAll, describeCompareOutcome, updateBaseline } from "./compare.ts";
import { pngDimensions } from "./png.ts";

const viewport = { width: 800, height: 600 };

/** A solid mid-grey PNG with `changed` pixels flipped to black along the top row. */
function png(width: number, height: number, changed = 0): Buffer {
  const image = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    const black = i < changed;
    image.data[i * 4] = black ? 0 : 128;
    image.data[i * 4 + 1] = black ? 0 : 128;
    image.data[i * 4 + 2] = black ? 0 : 128;
    image.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(image);
}

let outDir: string;

function capture(buffer: Buffer): CaptureResult {
  return {
    storyKey: "Components/Avatar--Group",
    mode: "light",
    viewport,
    buffer,
    outputPath: join(outDir, "Components--Avatar--Group-light.png"),
    dimensions: pngDimensions(buffer)!,
  };
}

const exists = (path: string) => Bun.file(path).exists();

beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), "storybun-compare-"));
});

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
});

describe("compareAll", () => {
  test("an identical capture passes and leaves no actual or diff image", async () => {
    const c = capture(png(10, 10));
    await Bun.write(c.outputPath, png(10, 10));

    const [result] = await compareAll([c], 0.1);

    expect(result).toMatchObject({ status: "pass", diffPercent: 0 });
    expect(await exists(join(outDir, "Components--Avatar--Group-light.actual.png"))).toBe(false);
    expect(await exists(join(outDir, "Components--Avatar--Group-light.diff.png"))).toBe(false);
  });

  test("by default a single differing pixel is a change", async () => {
    const c = capture(png(10, 10, 1));
    await Bun.write(c.outputPath, png(10, 10));

    const [result] = await compareAll([c], 0.1);

    expect(result).toMatchObject({ status: "fail", diffPercent: 1 });
    expect(await exists(join(outDir, "Components--Avatar--Group-light.actual.png"))).toBe(true);
    expect(await exists(join(outDir, "Components--Avatar--Group-light.diff.png"))).toBe(true);
  });

  test("a difference within maxDiffPixels passes, reports its share and drops stale images", async () => {
    const c = capture(png(10, 10, 3));
    await Bun.write(c.outputPath, png(10, 10));
    // Left behind by an earlier run that flagged this story.
    const actualPath = join(outDir, "Components--Avatar--Group-light.actual.png");
    const diffPath = join(outDir, "Components--Avatar--Group-light.diff.png");
    await Bun.write(actualPath, png(10, 10, 3));
    await Bun.write(diffPath, png(10, 10));

    const [result] = await compareAll([c], 0.1, 3);

    expect(result).toMatchObject({ status: "pass", diffPercent: 3 });
    expect(await exists(actualPath)).toBe(false);
    expect(await exists(diffPath)).toBe(false);
    // The baseline is untouched: a tolerated pass is not an update.
    expect(Buffer.from(await Bun.file(c.outputPath).arrayBuffer()).equals(png(10, 10))).toBe(true);
  });

  test("one pixel over maxDiffPixels is still a change", async () => {
    const c = capture(png(10, 10, 4));
    await Bun.write(c.outputPath, png(10, 10));

    const [result] = await compareAll([c], 0.1, 3);

    expect(result).toMatchObject({ status: "fail", diffPercent: 4 });
  });

  test("maxDiffPixels never excuses a dimension change", async () => {
    const c = capture(png(10, 12));
    await Bun.write(c.outputPath, png(10, 10));

    const [result] = await compareAll([c], 0.1, 1_000_000);

    expect(result).toMatchObject({ status: "fail", diffPercent: 100 });
  });
});

describe("updateBaseline", () => {
  test("writes the capture as the baseline and clears stale actual/diff images", async () => {
    const c = capture(png(4, 4));
    await Bun.write(c.outputPath, png(4, 4, 3));
    await Bun.write(c.outputPath.replace(/\.png$/, ".actual.png"), png(1, 1));
    await Bun.write(c.outputPath.replace(/\.png$/, ".diff.png"), png(1, 1));

    await updateBaseline(c);

    expect(Buffer.from(await Bun.file(c.outputPath).arrayBuffer()).equals(c.buffer)).toBe(true);
    expect(await exists(c.outputPath.replace(/\.png$/, ".actual.png"))).toBe(false);
    expect(await exists(c.outputPath.replace(/\.png$/, ".diff.png"))).toBe(false);
  });
});

describe("describeCompareOutcome", () => {
  test("says nothing for a pass, names a new baseline and a change with its share", () => {
    const base = { storyKey: "A--B", outputPath: "/out/A--B.png" };
    expect(describeCompareOutcome({ ...base, status: "pass", diffPercent: 0 })).toBeUndefined();
    expect(describeCompareOutcome({ ...base, status: "pass", diffPercent: 0.01 })).toBeUndefined();
    expect(describeCompareOutcome({ ...base, status: "new", diffPercent: 0 })).toBe("+ new");
    expect(describeCompareOutcome({ ...base, status: "fail", diffPercent: 3.21 })).toBe("changed 3.2%");
  });
});
