import type { StoryEntry } from "./types.ts";

export interface StoryKey {
  /** Fully qualified key, e.g. "Components/Button--Primary" */
  key: string;
  /** Display path, e.g. "Components/Button" */
  path: string;
  /** Named export within the story file */
  exportName: string;
  /** Absolute path of the file declaring the story */
  filePath: string;
  packageName: string;
}

export function storyKeys(stories: StoryEntry[]): StoryKey[] {
  return stories.flatMap((story) =>
    story.exports.map((exportName) => ({
      key: `${story.path}--${exportName}`,
      path: story.path,
      exportName,
      filePath: story.filePath,
      packageName: story.packageName,
    })),
  );
}

export type ResolveResult =
  | { ok: true; story: StoryKey; exact: boolean }
  | { ok: false; suggestions: StoryKey[] };

/**
 * Resolve a user-supplied key to exactly one story.
 *
 * Exact matches win outright. Failing that a case-insensitive match, then a
 * unique substring match, is accepted -- typing the export name alone is the
 * common case and there is no ambiguity when only one story contains it. A
 * query matching several stories is an error rather than a silent pick, so a
 * caller never gets a screenshot of a story it did not name.
 */
export function resolveStoryKey(
  stories: StoryEntry[],
  query: string,
): ResolveResult {
  const all = storyKeys(stories);

  const exact = all.find((s) => s.key === query);
  if (exact) return { ok: true, story: exact, exact: true };

  const lower = query.toLowerCase();

  const caseInsensitive = all.filter((s) => s.key.toLowerCase() === lower);
  if (caseInsensitive.length === 1) {
    return { ok: true, story: caseInsensitive[0]!, exact: false };
  }

  const partial = all.filter((s) => s.key.toLowerCase().includes(lower));
  if (partial.length === 1) {
    return { ok: true, story: partial[0]!, exact: false };
  }

  return { ok: false, suggestions: partial.slice(0, 10) };
}
