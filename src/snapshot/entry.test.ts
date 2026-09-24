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

  test("injects a fit-content width rule scoped to the marker", () => {
    const stories: StoryEntry[] = [
      { path: "a/b", filePath: "/tmp/a.stories.tsx", exports: ["Foo"], packageName: "test-pkg" },
    ];
    const code = generateSnapshotEntry(stories, testPackages(), testConfig(), "/tmp");

    expect(code).toMatch(/\[data-storybun-story\]\s*\{\s*width:\s*fit-content;?\s*\}/);
  });
});
