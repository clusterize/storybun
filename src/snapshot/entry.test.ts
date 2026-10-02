import { describe, test, expect } from "bun:test";
import { generateSnapshotEntry, generateSnapshotHtml } from "./entry.ts";
import type { PackageInfo, ResolvedConfig, StoryEntry } from "../types.ts";

function testConfig(): ResolvedConfig {
  return {
    stories: [],
    ignore: [],
    port: 0,
    plugins: [],
    components: {},
    snapshot: {
      outDir: "__snapshots__",
      threshold: 0.1,
      maxDiffPixels: 0,
      viewports: [{ width: 800, height: 600 }],
      settleTimeout: 2_000,
      concurrency: 1,
      codeowners: [],
      clock: null,
      timezoneId: "UTC",
      locale: "en-US",
      modes: {},
      report: { component: null },
    },
  };
}

function testPackages(): Map<string, PackageInfo> {
  const packages = new Map<string, PackageInfo>();
  packages.set("test-pkg", {
    name: "test-pkg",
    dir: "/tmp",
    config: { plugins: [], components: {} },
  });
  return packages;
}

describe("generateSnapshotEntry", () => {
  test("wraps the rendered story in a data-storybun-story marker", () => {
    const stories: StoryEntry[] = [
      { path: "a/b", filePath: "/tmp/a.stories.tsx", exports: ["Foo"], packageName: "test-pkg" },
    ];
    const code = generateSnapshotEntry(stories, testPackages(), testConfig(), "/tmp");

    expect(code).toContain('"data-storybun-story"');
    expect(code).toContain(
      'React.createElement("div", { "data-storybun-story": "" }, React.createElement(Story))',
    );
  });

  test("does not inject a width override on the story marker", () => {
    // A story whose own layout genuinely fills its available width (e.g.
    // width: 100%, a CSS grid) must capture full-width -- that's a deliberate
    // choice, not a bug. A CSS width override on the marker (like the
    // fit-content rule this replaces) would silently collapse such stories
    // to their content's preferred width instead.
    const stories: StoryEntry[] = [
      { path: "a/b", filePath: "/tmp/a.stories.tsx", exports: ["Foo"], packageName: "test-pkg" },
    ];
    const code = generateSnapshotEntry(stories, testPackages(), testConfig(), "/tmp");

    expect(code).not.toMatch(/\[data-storybun-story\]\s*\{[^}]*width/);
  });
});

describe("generateSnapshotEntry readiness hooks", () => {
  const stories: StoryEntry[] = [
    { path: "a/b", filePath: "/tmp/a.stories.tsx", exports: ["Foo"], packageName: "test-pkg" },
  ];

  test("keeps the CSS animation kill switch as the backstop for reduced-motion emulation", () => {
    const code = generateSnapshotEntry(stories, testPackages(), testConfig(), "/tmp");
    expect(code).toContain("animation-duration: 0s !important");
    expect(code).toContain("transition-duration: 0s !important");
  });

  test("records iframe load events for the settle check, from before any story renders", () => {
    const code = generateSnapshotEntry(stories, testPackages(), testConfig(), "/tmp");
    expect(code).toContain("__storybunLoadedFrames");
    // The listener must be registered in the capture phase, since `load`
    // does not bubble, and before `renderStory()` is called.
    expect(code.indexOf('addEventListener(\n  "load"')).toBeGreaterThan(-1);
    expect(code.indexOf("__storybunLoadedFrames")).toBeLessThan(code.indexOf("renderStory()"));
  });
});

describe("generateSnapshotHtml", () => {
  test("flags the document as a snapshot capture before any script runs", () => {
    const html = generateSnapshotHtml(new Map());
    expect(html).toContain('<html lang="en" data-storybun-snapshot>');
  });
});

// Browser-driven coverage of renderStory's error branches lives in
// capture.test.ts, which owns the single shared Chromium instance for this
// package -- launching a second, separate browser instance from this file
// intermittently crashes Chromium on this host (observed via `ps` sampling:
// the second browser's process tree vanishes mid-run, well before close()
// is even called), hanging captureAll's `browser.close()` afterAll for the
// full hook timeout. Not a code bug; keeping all real-Chromium tests in one
// file with one browser sidesteps it.
