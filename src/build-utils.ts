import { dirname } from "path";
import type { BunPlugin } from "bun";
import type { StoryEntry } from "./types.ts";

export function findReactResolveDir(stories: StoryEntry[], cwd: string): string {
  try {
    Bun.resolveSync("react", cwd);
    return cwd;
  } catch {}

  const dirs = new Set(stories.map((s) => dirname(s.filePath)));
  for (const dir of dirs) {
    try {
      Bun.resolveSync("react", dir);
      return dir;
    } catch {}
  }

  return cwd;
}

export function createReactPlugin(reactDir: string): BunPlugin {
  return {
    name: "resolve-react",
    setup(build) {
      build.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, (args) => {
        return { path: Bun.resolveSync(args.path, reactDir) };
      });
    },
  };
}
