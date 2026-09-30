import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "path";
import { PNG } from "pngjs";

import type { ResolvedSnapshotConfig } from "../types.ts";
import type { CaptureFailure, CaptureResult } from "./capture.ts";
import { pruneBaselines, type CompareResult } from "./compare.ts";
import {
  buildReport,
  findRemovedBaselines,
  pngDimensions,
  type SnapshotReport,
} from "./report-model.ts";
import { DefaultReport, loadReportTemplate, renderReportHtml } from "./report-html.tsx";
import {
  imagePrefixFor,
  resolveReportPath,
  writeHtmlReport,
  writeJsonReport,
} from "./report-files.ts";

const fixturesDir = join(import.meta.dir, "__fixtures__");

function png(width: number, height: number, fill = 0): Buffer {
  const image = new PNG({ width, height });
  image.data.fill(fill);
  return PNG.sync.write(image);
}

let outDir: string;
let cwd: string;
const viewport = { width: 800, height: 600 };
const now = new Date("2026-09-29T10:00:00.000Z");

function config(): ResolvedSnapshotConfig {
  return {
    outDir,
    threshold: 0.1,
    viewports: [viewport],
    waitTimeout: 0,
    concurrency: 1,
    codeowners: [],
    clock: "2026-07-30T12:00:00.000Z",
    timezoneId: "UTC",
    locale: "en-US",
    modes: { light: { colorScheme: "light" }, dark: { colorScheme: "dark" } },
    report: { component: null },
  };
}

function capture(storyKey: string, mode: string, buffer: Buffer): CaptureResult {
  const file = `${storyKey.replace(/\//g, "--")}-${mode}.png`;
  return { storyKey, mode, viewport, buffer, outputPath: join(outDir, file) };
}

function compared(c: CaptureResult, status: CompareResult["status"], diffPercent = 0): CompareResult {
  return { storyKey: c.storyKey, mode: c.mode, status, diffPercent, outputPath: c.outputPath };
}

// A mixed run, laid out on disk exactly as compareAll leaves it:
//   Button--Primary   light: pass        (baseline only)
//   Button--Primary   dark:  changed     (baseline, actual, diff; same size)
//   Card--Wide        light: changed     (baseline, actual, dimension change -> no diff)
//   Card--Wide        dark:  new         (freshly written baseline only)
//   Timeline--Empty   light: capture failed
//   Old--Gone         (stale baseline no story produced)
let captures: CaptureResult[];
let results: CompareResult[];
let failures: CaptureFailure[];

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "storybun-report-"));
  outDir = join(cwd, "__snapshots__");

  const primaryLight = capture("Components/Button--Primary", "light", png(120, 40));
  const primaryDark = capture("Components/Button--Primary", "dark", png(120, 40, 255));
  const wideLight = capture("Components/Card--Wide", "light", png(300, 200));
  const wideDark = capture("Components/Card--Wide", "dark", png(300, 200));
  captures = [wideDark, primaryDark, wideLight, primaryLight]; // deliberately unsorted

  await Bun.write(primaryLight.outputPath, primaryLight.buffer);
  await Bun.write(primaryDark.outputPath, png(120, 40, 0));
  await Bun.write(primaryDark.outputPath.replace(/\.png$/, ".actual.png"), primaryDark.buffer);
  await Bun.write(primaryDark.outputPath.replace(/\.png$/, ".diff.png"), png(120, 40, 128));
  await Bun.write(wideLight.outputPath, png(300, 150)); // old baseline, different height
  await Bun.write(wideLight.outputPath.replace(/\.png$/, ".actual.png"), wideLight.buffer);
  await Bun.write(wideLight.outputPath.replace(/\.png$/, ".diff.png"), png(1, 1)); // stale, must be ignored
  await Bun.write(wideDark.outputPath, wideDark.buffer);
  await Bun.write(join(outDir, "Components--Old--Gone-light.png"), png(10, 10));

  results = [
    compared(primaryLight, "pass"),
    compared(primaryDark, "fail", 12.5),
    compared(wideLight, "fail", 100),
    compared(wideDark, "new"),
  ];
  failures = [
    {
      storyKey: "Components/Timeline--Empty",
      viewport,
      mode: "light",
      outputPath: join(outDir, "Components--Timeline--Empty-light.png"),
      error: new Error("the story rendered nothing with a measurable box\nsecond line"),
    },
  ];
});

afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function mixedReport(): Promise<SnapshotReport> {
  const removed = await findRemovedBaselines(
    outDir,
    [...captures, ...failures].map((c) => c.outputPath),
  );
  return buildReport({
    captures,
    compared: results,
    failures,
    removed,
    config: config(),
    outDirName: "__snapshots__",
    exitCode: 1,
    commit: "0123456789abcdef",
    now,
  });
}

describe("pngDimensions", () => {
  test("reads width and height from the header without decoding", () => {
    expect(pngDimensions(png(120, 40))).toEqual({ width: 120, height: 40 });
    expect(pngDimensions(Buffer.from("not a png"))).toBeNull();
  });
});

describe("findRemovedBaselines", () => {
  test("lists baselines no story produced, ignoring actual and diff images", async () => {
    const removed = await findRemovedBaselines(
      outDir,
      [...captures, ...failures].map((c) => c.outputPath),
    );
    expect(removed).toEqual([join(outDir, "Components--Old--Gone-light.png")]);
  });

  test("a failed capture's baseline is not removed", async () => {
    await Bun.write(failures[0]!.outputPath, png(5, 5));
    try {
      const removed = await findRemovedBaselines(
        outDir,
        [...captures, ...failures].map((c) => c.outputPath),
      );
      expect(removed.map((p) => p.split("/").pop())).toEqual(["Components--Old--Gone-light.png"]);
    } finally {
      await rm(failures[0]!.outputPath);
    }
  });

  test("a missing outDir yields nothing", async () => {
    expect(await findRemovedBaselines(join(cwd, "nope"), [])).toEqual([]);
  });
});

describe("buildReport", () => {
  test("one entry per outcome, sorted by story key, then mode, then viewport", async () => {
    const report = await mixedReport();
    expect(report.results.map((r) => [r.storyKey, r.mode, r.status])).toEqual([
      ["Components--Old--Gone-light", null, "removed"],
      ["Components/Button--Primary", "dark", "changed"],
      ["Components/Button--Primary", "light", "pass"],
      ["Components/Card--Wide", "dark", "new"],
      ["Components/Card--Wide", "light", "changed"],
      ["Components/Timeline--Empty", "light", "capture-failed"],
    ]);
  });

  test("summary counts every status and carries the run's exit code", async () => {
    const report = await mixedReport();
    expect(report.summary).toEqual({
      total: 6,
      passed: 1,
      changed: 2,
      new: 1,
      removed: 1,
      captureFailed: 1,
      updated: 0,
      exitCode: 1,
    });
    expect(report.version).toBe(1);
    expect(report.generatedAt).toBe(now.toISOString());
    expect(report.outDir).toBe("__snapshots__");
    expect(report.commit).toBe("0123456789abcdef");
    expect(report.config).toEqual({
      threshold: 0.1,
      viewports: [viewport],
      modes: ["light", "dark"],
      clock: "2026-07-30T12:00:00.000Z",
      locale: "en-US",
      timezoneId: "UTC",
    });
  });

  test("a passed story lists only its baseline", async () => {
    const [entry] = (await mixedReport()).results.filter((r) => r.status === "pass");
    expect(entry).toMatchObject({
      diffPercent: 0,
      dimensions: { baseline: { width: 120, height: 40 }, actual: { width: 120, height: 40 } },
      files: { baseline: "Components--Button--Primary-light.png", actual: null, diff: null },
      viewport,
      error: null,
    });
  });

  test("a pixel change lists baseline, actual and diff with paths relative to outDir", async () => {
    const entry = (await mixedReport()).results.find(
      (r) => r.storyKey === "Components/Button--Primary" && r.mode === "dark",
    )!;
    expect(entry).toMatchObject({
      status: "changed",
      diffPercent: 12.5,
      dimensions: { baseline: { width: 120, height: 40 }, actual: { width: 120, height: 40 } },
      files: {
        baseline: "Components--Button--Primary-dark.png",
        actual: "Components--Button--Primary-dark.actual.png",
        diff: "Components--Button--Primary-dark.diff.png",
      },
    });
  });

  test("a dimension change reports both sizes and no diff image, even if a stale one is on disk", async () => {
    const entry = (await mixedReport()).results.find(
      (r) => r.storyKey === "Components/Card--Wide" && r.mode === "light",
    )!;
    expect(entry).toMatchObject({
      status: "changed",
      diffPercent: 100,
      dimensions: { baseline: { width: 300, height: 150 }, actual: { width: 300, height: 200 } },
      files: {
        baseline: "Components--Card--Wide-light.png",
        actual: "Components--Card--Wide-light.actual.png",
        diff: null,
      },
    });
  });

  test("a new story lists its freshly written baseline as its only image", async () => {
    const [entry] = (await mixedReport()).results.filter((r) => r.status === "new");
    expect(entry).toMatchObject({
      diffPercent: null,
      dimensions: { baseline: { width: 300, height: 200 }, actual: null },
      files: { baseline: "Components--Card--Wide-dark.png", actual: null, diff: null },
    });
  });

  test("a capture failure keeps the first line of its error and lists no files", async () => {
    const [entry] = (await mixedReport()).results.filter((r) => r.status === "capture-failed");
    expect(entry).toMatchObject({
      storyKey: "Components/Timeline--Empty",
      mode: "light",
      viewport,
      diffPercent: null,
      dimensions: { baseline: null, actual: null },
      files: { baseline: null, actual: null, diff: null },
      error: "the story rendered nothing with a measurable box",
    });
  });

  test("a removed baseline is reported with its file and dimensions, keyed by filename", async () => {
    const [entry] = (await mixedReport()).results.filter((r) => r.status === "removed");
    expect(entry).toMatchObject({
      storyKey: "Components--Old--Gone-light",
      mode: null,
      viewport: null,
      dimensions: { baseline: { width: 10, height: 10 }, actual: null },
      files: { baseline: "Components--Old--Gone-light.png", actual: null, diff: null },
    });
  });

  test("an --update run marks every capture as updated", async () => {
    const report = await buildReport({
      captures,
      compared: null,
      failures: [],
      removed: [],
      config: config(),
      outDirName: "__snapshots__",
      exitCode: 0,
      now,
    });
    expect(new Set(report.results.map((r) => r.status))).toEqual(new Set(["updated"]));
    expect(report.summary).toMatchObject({ total: 4, updated: 4, passed: 0, changed: 0, exitCode: 0 });
    expect(report.results[0]!.files).toEqual({
      baseline: "Components--Button--Primary-dark.png",
      actual: null,
      diff: null,
    });
    expect(report.commit).toBeNull();
  });
});

describe("pruning removed baselines (--update)", () => {
  test("a pruned report lists the removed entry with its dimensions but no file", async () => {
    const report = await buildReport({
      captures,
      compared: null,
      failures: [],
      removed: [join(outDir, "Components--Old--Gone-light.png")],
      pruned: true,
      config: config(),
      outDirName: "__snapshots__",
      exitCode: 0,
      now,
    });
    const [entry] = report.results.filter((r) => r.status === "removed");
    expect(entry).toMatchObject({
      storyKey: "Components--Old--Gone-light",
      dimensions: { baseline: { width: 10, height: 10 }, actual: null },
      files: { baseline: null, actual: null, diff: null },
    });
    expect(report.summary.removed).toBe(1);
  });

  test("pruneBaselines deletes the baseline and its stale actual and diff, nothing else", async () => {
    const stale = join(outDir, "Components--Stale--One-light.png");
    await Bun.write(stale, png(4, 4));
    await Bun.write(stale.replace(/\.png$/, ".actual.png"), png(4, 4));
    await Bun.write(stale.replace(/\.png$/, ".diff.png"), png(4, 4));
    const keep = captures[0]!.outputPath;

    expect(await pruneBaselines([stale])).toBe(1);

    expect(await Bun.file(stale).exists()).toBe(false);
    expect(await Bun.file(stale.replace(/\.png$/, ".actual.png")).exists()).toBe(false);
    expect(await Bun.file(stale.replace(/\.png$/, ".diff.png")).exists()).toBe(false);
    expect(await Bun.file(keep).exists()).toBe(true);
    expect(await Bun.file(join(outDir, "Components--Old--Gone-light.png")).exists()).toBe(true);
  });

  test("pruning a path that is already gone is not an error", async () => {
    expect(await pruneBaselines([join(outDir, "never-existed.png")])).toBe(1);
  });
});

describe("JSON report", () => {
  test("round-trips through the file", async () => {
    const report = await mixedReport();
    const path = join(cwd, "out", "nested", "report.json");
    await writeJsonReport(path, report);
    const parsed = JSON.parse(await Bun.file(path).text());
    expect(parsed).toEqual(JSON.parse(JSON.stringify(report)));
    expect(parsed.results[1].files.diff).toBe("Components--Button--Primary-dark.diff.png");
  });
});

describe("HTML report", () => {
  test("renders a self-contained page with a badge per entry and relative image paths", async () => {
    const html = renderReportHtml(await mixedReport(), "");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toMatch(/<script/);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain("<style>");

    expect(html).toContain('<span class="badge">changed</span>');
    expect(html).toContain('<span class="badge">new</span>');
    expect(html).toContain('<span class="badge">removed</span>');
    expect(html).toContain('<span class="badge">capture failed</span>');
    expect(html).toContain('<span class="badge">passed</span>');

    expect(html).toContain('src="Components--Button--Primary-dark.png"');
    expect(html).toContain('src="Components--Button--Primary-dark.actual.png"');
    expect(html).toContain('src="Components--Button--Primary-dark.diff.png"');
    expect(html).toContain("12.5% diff");
    expect(html).toContain("commit 0123456");
    expect(html).toContain("clock frozen at 2026-07-30T12:00:00.000Z");
  });

  test("a changed capture gets a three-column grid and a script-free flip view between before, after and diff", async () => {
    const html = renderReportHtml(await mixedReport(), "");
    expect(html).not.toMatch(/<script/);
    // The Button--Primary dark entry: pixel change with a diff image.
    const start = html.indexOf("Components--Button--Primary-dark.png");
    const entry = html.slice(html.lastIndexOf('<div class="compare">', start), html.indexOf("</article>", start));
    expect(entry).toContain('class="pane pane-grid images cols-3"');
    expect(entry.match(/<input type="radio"/g)).toHaveLength(4);
    expect(entry).toContain('<label class="l-grid" for="s1e0-grid">side by side</label>');
    expect(entry).toContain('<label class="l-before" for="s1e0-before">before</label>');
    expect(entry).toContain('<label class="l-after" for="s1e0-after">after</label>');
    expect(entry).toContain('<label class="l-diff" for="s1e0-diff">diff</label>');
    expect(entry).toContain('class="t-grid" id="s1e0-grid" name="s1e0" checked=""');
    expect(entry).toContain('class="pane pane-after single"');
    expect(entry).toContain('class="pane pane-diff single"');
  });

  test("radio groups are unique per entry across stories", async () => {
    const html = renderReportHtml(await mixedReport(), "");
    const names = [...html.matchAll(/ name="(s\d+e\d+)"/g)].map((m) => m[1]);
    expect(new Set(names).size).toBe(2); // two changed entries in the fixture
  });

  test("a dimension change shows both sizes and no diff column", async () => {
    const html = renderReportHtml(await mixedReport(), "");
    expect(html).toContain("300×150 → 300×200");
    expect(html).not.toContain('src="Components--Card--Wide-light.diff.png"');
  });

  test("a capture failure shows its error line", async () => {
    const html = renderReportHtml(await mixedReport(), "");
    expect(html).toContain("the story rendered nothing with a measurable box");
  });

  test("stories needing attention come first, fully passed ones are folded into a details element", async () => {
    const report = await mixedReport();
    // A story whose every entry passed; it goes below the fold.
    report.results.unshift({
      storyKey: "Components/Badge--Small",
      mode: "light",
      viewport,
      status: "pass",
      diffPercent: 0,
      dimensions: { baseline: { width: 10, height: 10 }, actual: { width: 10, height: 10 } },
      files: { baseline: "Components--Badge--Small-light.png", actual: null, diff: null },
      error: null,
    });
    const html = renderReportHtml(report, "");
    const fold = html.indexOf('<details class="quiet">');
    expect(fold).toBeGreaterThan(-1);
    expect(html).toContain("<summary>1 passed story</summary>");
    expect(html.indexOf("Components/Badge--Small")).toBeGreaterThan(fold);
    expect(html.indexOf("Components/Card--Wide")).toBeLessThan(fold);
    // Button--Primary has a changed dark entry, so it sits above the fold
    // even though its light entry passed.
    expect(html.indexOf("Components/Button--Primary")).toBeLessThan(fold);
  });

  test("applies the image prefix to every src", async () => {
    const html = renderReportHtml(await mixedReport(), "../__snapshots__/");
    expect(html).toContain('src="../__snapshots__/Components--Button--Primary-dark.actual.png"');
    expect(html).not.toContain('src="Components--');
  });

  test("escapes story keys and error text", async () => {
    const report = await mixedReport();
    report.results[0]!.storyKey = "<img src=x onerror=alert(1)>";
    report.results.find((r) => r.status === "capture-failed")!.error = "<b>&</b>";
    const html = renderReportHtml(report, "");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;b&gt;&amp;&lt;/b&gt;");
  });

  test("an --update report folds every entry under an updated summary", async () => {
    const report = await buildReport({
      captures,
      compared: null,
      failures: [],
      removed: [],
      config: config(),
      outDirName: "__snapshots__",
      exitCode: 0,
      now,
    });
    const html = renderReportHtml(report, "");
    expect(html).toContain("<summary>2 updated stories</summary>");
  });

  test("a custom template replaces the default page and receives the same props", async () => {
    const Template = await loadReportTemplate(cwd, join(fixturesDir, "custom-report.tsx"));
    const html = renderReportHtml(await mixedReport(), "img/", Template);
    expect(html).toContain("<h1>custom template</h1>");
    expect(html).toContain('data-image-prefix="img/"');
    expect(html).toContain("<li>Components/Card--Wide: new</li>");
    expect(html).not.toContain('class="badge"');
  });

  test("a template module without a component is rejected with a clear message", async () => {
    await expect(loadReportTemplate(cwd, join(fixturesDir, "bad-report.ts"))).rejects.toThrow(
      /must export a React component/,
    );
  });

  test("the default template is exported for reuse", async () => {
    expect(renderReportHtml(await mixedReport(), "", DefaultReport)).toBe(
      renderReportHtml(await mixedReport(), ""),
    );
  });
});

describe("report paths", () => {
  test("a bare flag resolves to the default file inside outDir", () => {
    expect(resolveReportPath(true, "/proj", "/proj/__snapshots__", "report.json")).toBe(
      "/proj/__snapshots__/report.json",
    );
  });

  test("a relative path resolves against the project root, an absolute one is kept", () => {
    expect(resolveReportPath("out/r.html", "/proj", "/proj/__snapshots__", "report.html")).toBe(
      "/proj/out/r.html",
    );
    expect(resolveReportPath("/elsewhere/r.html", "/proj", "/proj/__snapshots__", "report.html")).toBe(
      "/elsewhere/r.html",
    );
  });

  test("image prefix is empty inside outDir and a relative directory elsewhere", () => {
    expect(imagePrefixFor("/proj/__snapshots__/report.html", "/proj/__snapshots__")).toBe("");
    expect(imagePrefixFor("/proj/out/report.html", "/proj/__snapshots__")).toBe("../__snapshots__/");
    expect(imagePrefixFor("/proj/report.html", "/proj/__snapshots__")).toBe("__snapshots__/");
  });

  test("writeHtmlReport places images relative to the written file", async () => {
    const path = join(cwd, "docs", "report.html");
    await writeHtmlReport(path, await mixedReport(), outDir);
    const html = await Bun.file(path).text();
    expect(html).toContain('src="../__snapshots__/Components--Button--Primary-dark.png"');
  });
});
