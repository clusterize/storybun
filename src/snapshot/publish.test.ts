import { describe, test, expect } from "bun:test";
import type { ReportEntry, ReportImages, SnapshotReport } from "./report-model.ts";
import { filesToPublish, imagesPublished } from "./publish.ts";

function entry(stem: string, status: ReportEntry["status"], files: Partial<ReportEntry["files"]> = {}): ReportEntry {
  return {
    storyKey: stem,
    mode: null,
    viewport: null,
    status,
    diffPercent: null,
    dimensions: { baseline: null, actual: null },
    files: { baseline: `${stem}.png`, actual: null, diff: null, ...files },
    error: null,
  };
}

function report(results: ReportEntry[], images?: ReportImages): SnapshotReport {
  return {
    version: 1,
    generatedAt: "2026-11-05T10:00:00.000Z",
    outDir: "__snapshots__",
    commit: null,
    ...(images ? { images } : {}),
    summary: { total: results.length, passed: 0, changed: 0, new: 0, removed: 0, captureFailed: 0, updated: 0, exitCode: 0 },
    config: { threshold: 0.1, maxDiffPixels: 0, viewports: [], modes: [], clock: null, locale: "en-US", timezoneId: "UTC" },
    results,
  };
}

const mixed = [
  entry("Pass", "pass"),
  entry("Changed", "changed", { actual: "Changed.actual.png", diff: "Changed.diff.png" }),
  entry("Resized", "changed", { actual: "Resized.actual.png" }),
  entry("New", "new"),
  entry("Removed", "removed"),
  entry("Pruned", "removed", { baseline: null }),
  entry("Failed", "capture-failed", { baseline: null }),
];

describe("filesToPublish", () => {
  test("review: only the images of changed, new and removed captures", () => {
    expect(filesToPublish(report(mixed, "review"))).toEqual([
      "Changed.png",
      "Changed.actual.png",
      "Changed.diff.png",
      "Resized.png",
      "Resized.actual.png",
      "New.png",
      "Removed.png",
    ]);
  });

  test("review: a passing or updated run publishes no image at all", () => {
    expect(filesToPublish(report([entry("A", "pass"), entry("B", "pass")], "review"))).toEqual([]);
    expect(filesToPublish(report([entry("A", "updated")], "review"))).toEqual([]);
  });

  test("all: every image the report lists, passed baselines included", () => {
    expect(filesToPublish(report(mixed, "all"))).toEqual([
      "Pass.png",
      "Changed.png",
      "Changed.actual.png",
      "Changed.diff.png",
      "Resized.png",
      "Resized.actual.png",
      "New.png",
      "Removed.png",
    ]);
  });

  test("a report without the field, from before it existed, publishes everything", () => {
    expect(filesToPublish(report(mixed))).toEqual(filesToPublish(report(mixed, "all")));
  });

  test("a file listed by two entries is published once", () => {
    expect(filesToPublish(report([entry("A", "new"), entry("A", "removed")], "review"))).toEqual(["A.png"]);
  });
});

describe("imagesPublished", () => {
  test("under review, false only for passed and updated captures", () => {
    const r = { images: "review" as const };
    expect(imagesPublished(r, { status: "pass" })).toBe(false);
    expect(imagesPublished(r, { status: "updated" })).toBe(false);
    for (const status of ["changed", "new", "removed", "capture-failed"] as const) {
      expect(imagesPublished(r, { status })).toBe(true);
    }
  });

  test("always true under all or without the field", () => {
    expect(imagesPublished({ images: "all" }, { status: "pass" })).toBe(true);
    expect(imagesPublished({}, { status: "pass" })).toBe(true);
  });
});
