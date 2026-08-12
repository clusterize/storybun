import { relative } from "path";
import { loadConfig } from "./config.ts";
import { scanStories } from "./scanner.ts";
import { storyKeys } from "./story-keys.ts";

export interface ListOptions {
  json: boolean;
  filter?: string;
}

/**
 * Print every story key. Discovery has to exist for `storybun shot` to be
 * usable without reverse-engineering the naming rules in the scanner, and it
 * needs neither a bundle nor a browser -- scanning the source is enough.
 */
export async function runList(
  cwd: string,
  options: ListOptions,
): Promise<number> {
  const config = await loadConfig(cwd);
  const { stories } = await scanStories(config, cwd);

  let keys = storyKeys(stories);
  if (options.filter) {
    const needle = options.filter.toLowerCase();
    keys = keys.filter((s) => s.key.toLowerCase().includes(needle));
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        keys.map((s) => ({
          key: s.key,
          path: s.path,
          export: s.exportName,
          file: relative(cwd, s.filePath),
          package: s.packageName,
        })),
        null,
        2,
      ),
    );
  } else {
    for (const s of keys) {
      console.log(s.key);
    }
  }

  return keys.length > 0 ? 0 : 1;
}
