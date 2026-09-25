import { describe, test, expect } from "bun:test";
import { generateSnapshotEntry } from "./entry.ts";
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
      viewports: [{ width: 800, height: 600 }],
      waitTimeout: 0,
      concurrency: 1,
      codeowners: [],
      clock: null,
      timezoneId: "UTC",
      locale: "en-US",
      modes: {},
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

// Browser-driven coverage of renderStory's error branches lives in
// capture.test.ts, which owns the single shared Chromium instance for this
// package -- launching a second, separate browser instance from this file
// intermittently crashes Chromium on this host (observed via `ps` sampling:
// the second browser's process tree vanishes mid-run, well before close()
// is even called), hanging captureAll's `browser.close()` afterAll for the
// full hook timeout. Not a code bug; keeping all real-Chromium tests in one
// file with one browser sidesteps it.
