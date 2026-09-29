import { describe, test, expect } from "bun:test";
import { formatDuration, formatPlan, formatProgress } from "./progress.ts";

const viewport = { width: 1280, height: 720 };

describe("formatDuration", () => {
  test("picks a unit that reads at a glance", () => {
    expect(formatDuration(412)).toBe("412ms");
    expect(formatDuration(1840)).toBe("1.8s");
    expect(formatDuration(92_000)).toBe("1m32s");
    expect(formatDuration(600_500)).toBe("10m01s");
  });
});

describe("formatProgress", () => {
  test("pads the counter to the total's width and labels mode", () => {
    const line = formatProgress(
      { index: 7, total: 618, storyKey: "Components/Button--Primary", mode: "dark", viewport, durationMs: 830 },
      true,
    );
    expect(line).toBe("[  7/618] Components/Button--Primary [dark] 830ms");
  });

  test("names the viewport only when more than one is configured", () => {
    const event = { index: 1, total: 1, storyKey: "A--B", viewport: { ...viewport, name: "desktop" }, durationMs: 10 };
    expect(formatProgress(event, true)).toBe("[1/1] A--B 10ms");
    expect(formatProgress(event, false)).toBe("[1/1] A--B @desktop 10ms");
    expect(formatProgress({ ...event, viewport }, false)).toBe("[1/1] A--B @1280x720 10ms");
  });

  test("marks a failure and keeps the first line of its error", () => {
    const line = formatProgress(
      {
        index: 3,
        total: 10,
        storyKey: "Timeline--Empty",
        mode: "light",
        viewport,
        durationMs: 1500,
        error: new Error("rendered nothing\nmore detail"),
      },
      true,
    );
    expect(line).toBe("[ 3/10] ✗ Timeline--Empty [light] 1.5s: rendered nothing");
  });
});

describe("formatPlan", () => {
  test("lists only the axes that are in play", () => {
    expect(formatPlan(42, 309, 1, 2, 618, 4)).toBe(
      "Capturing 618 snapshots (309 stories in 42 files × 2 modes) with concurrency 4",
    );
    expect(formatPlan(1, 1, 1, 0, 1, 1)).toBe("Capturing 1 snapshot (1 story in 1 file) with concurrency 1");
    expect(formatPlan(2, 5, 2, 0, 10, 4)).toBe(
      "Capturing 10 snapshots (5 stories in 2 files × 2 viewports) with concurrency 4",
    );
  });
});
