import { describe, test, expect } from "bun:test";
import { resolveStoryKey, storyKeys } from "./story-keys.ts";
import type { StoryEntry } from "./types.ts";

const stories: StoryEntry[] = [
  {
    path: "Components/Button",
    filePath: "/repo/src/Button.stories.tsx",
    exports: ["Primary", "Secondary"],
    packageName: "ui",
  },
  {
    path: "Components/Table",
    filePath: "/repo/src/Table.stories.tsx",
    exports: ["Wide"],
    packageName: "ui",
  },
];

describe("storyKeys", () => {
  test("flattens every export into a <path>--<export> key", () => {
    expect(storyKeys(stories).map((s) => s.key)).toEqual([
      "Components/Button--Primary",
      "Components/Button--Secondary",
      "Components/Table--Wide",
    ]);
  });
});

describe("resolveStoryKey", () => {
  test("an exact key wins and is reported as exact", () => {
    const result = resolveStoryKey(stories, "Components/Button--Primary");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.exact).toBe(true);
    expect(result.story.exportName).toBe("Primary");
  });

  test("a case-insensitive full key resolves, marked inexact", () => {
    const result = resolveStoryKey(stories, "components/button--primary");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.exact).toBe(false);
    expect(result.story.key).toBe("Components/Button--Primary");
  });

  test("a unique substring resolves", () => {
    const result = resolveStoryKey(stories, "wide");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.story.key).toBe("Components/Table--Wide");
  });

  test("an ambiguous substring fails and lists the candidates instead of guessing", () => {
    const result = resolveStoryKey(stories, "Button");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.suggestions.map((s) => s.key)).toEqual([
      "Components/Button--Primary",
      "Components/Button--Secondary",
    ]);
  });

  test("no match fails with no suggestions", () => {
    const result = resolveStoryKey(stories, "Nope");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.suggestions).toEqual([]);
  });
});
