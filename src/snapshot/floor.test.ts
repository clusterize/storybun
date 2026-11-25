import { describe, expect, test } from "bun:test";
import { PNG } from "pngjs";
import { assertRendered, BlankCaptureError, countColors } from "./floor.ts";
import type { CaptureResult } from "./capture.ts";
import type { ResolvedSnapshotConfig } from "../types.ts";

const VIEWPORT = { width: 40, height: 30 };

type Pixel = [number, number, number];

/** A PNG whose pixels cycle through `palette`, so its colour count is known. */
function png(palette: Pixel[]): Buffer {
  const image = new PNG(VIEWPORT);
  const pixels = VIEWPORT.width * VIEWPORT.height;
  for (let i = 0; i < pixels; i++) {
    const [r, g, b] = palette[i % palette.length]!;
    image.data.set([r, g, b, 255], i * 4);
  }
  return PNG.sync.write(image);
}

const WHITE: Pixel = [255, 255, 255];
const NEAR_WHITE: Pixel = [254, 255, 255];
const INK: Pixel = [24, 24, 27];

function capture(storyKey: string, palette: Pixel[]): CaptureResult {
  return {
    storyKey,
    viewport: VIEWPORT,
    buffer: png(palette),
    outputPath: `/out/${storyKey}.png`,
    dimensions: VIEWPORT,
  };
}

function config(overrides: Partial<ResolvedSnapshotConfig> = {}): ResolvedSnapshotConfig {
  return {
    outDir: "/out",
    threshold: 0.1,
    maxDiffPixels: 0,
    minColors: 2,
    minColorsIgnore: [],
    viewports: [VIEWPORT],
    settleTimeout: 10_000,
    markerTimeout: 500,
    concurrency: 1,
    codeowners: [],
    clock: null,
    timezoneId: "UTC",
    locale: "en-US",
    modes: {},
    environment: "",
    switchModesInPage: false,
    report: { component: null },
    ...overrides,
  };
}

describe("countColors", () => {
  test("counts a flat image as one colour", () => {
    expect(countColors(png([WHITE]))).toBe(1);
  });

  test("counts distinct colours exactly, without quantising", () => {
    expect(countColors(png([WHITE, NEAR_WHITE]))).toBe(2);
    expect(countColors(png([WHITE, NEAR_WHITE, INK]))).toBe(3);
  });

  test("ignores alpha, which a screenshot always leaves opaque", () => {
    const image = new PNG(VIEWPORT);
    for (let i = 0; i < VIEWPORT.width * VIEWPORT.height; i++) {
      image.data.set([255, 255, 255, i % 2 ? 255 : 128], i * 4);
    }
    expect(countColors(PNG.sync.write(image))).toBe(1);
  });

  test("stops counting once the floor is met", () => {
    expect(countColors(png([WHITE, NEAR_WHITE, INK]), 2)).toBe(2);
  });
});

describe("assertRendered", () => {
  test("fails a capture that painted a single flat colour", () => {
    expect(() => assertRendered(capture("Fade--Second", [WHITE]), config())).toThrow(
      BlankCaptureError,
    );
  });

  test("names the colour count and the floor in its message", () => {
    expect(() => assertRendered(capture("Fade--Second", [WHITE]), config())).toThrow(
      "rendered nothing (1 colour, below the snapshot.minColors floor of 2)",
    );
  });

  test("passes a render as sparse as a hairline separator", () => {
    expect(() => assertRendered(capture("Separator", [WHITE, NEAR_WHITE]), config())).not.toThrow();
  });

  test("exempts a story matched by minColorsIgnore", () => {
    const exempt = config({ minColorsIgnore: ["Tokens--"] });
    expect(() => assertRendered(capture("Tokens--Fill", [WHITE]), exempt)).not.toThrow();
    expect(() => assertRendered(capture("Fade--Second", [WHITE]), exempt)).toThrow(BlankCaptureError);
  });

  test("applies a raised floor", () => {
    expect(() =>
      assertRendered(capture("Separator", [WHITE, NEAR_WHITE]), config({ minColors: 8 })),
    ).toThrow("2 colours, below the snapshot.minColors floor of 8");
  });

  test("checks nothing when the floor is disabled", () => {
    expect(() => assertRendered(capture("Fade--Second", [WHITE]), config({ minColors: 0 }))).not.toThrow();
  });
});
