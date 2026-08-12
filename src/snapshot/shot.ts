import { isAbsolute, join, resolve } from "path";
import { loadConfig } from "../config.ts";
import { scanStories } from "../scanner.ts";
import { resolveStoryKey } from "../story-keys.ts";
import { buildSnapshotEntry } from "./entry.ts";
import { startSnapshotServer } from "./server.ts";
import { captureOne } from "./capture.ts";
import { loadPlaywright } from "./playwright.ts";

export interface ShotCommandOptions {
  story: string;
  out?: string;
  viewport?: { width: number; height: number };
  fullPage: boolean;
}

/** Read width and height straight out of the PNG IHDR chunk. */
function pngSize(buffer: Buffer): { width: number; height: number } {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function defaultOutPath(storyKey: string, cwd: string): string {
  return join(cwd, `${storyKey.replace(/\//g, "--")}.png`);
}

/**
 * Capture one story to an arbitrary path.
 *
 * Deliberately separate from `runSnapshots`: this writes exactly where it is
 * told and never reads, adopts, or rewrites a baseline, so asking for a picture
 * of a component cannot quietly commit a new expectation to `outDir`. The page
 * environment -- frozen clock, timezone, locale, wrappers -- is the snapshot
 * environment, so what you see here is what the baseline run sees.
 */
export async function runShot(
  cwd: string,
  options: ShotCommandOptions,
): Promise<number> {
  const playwright = await loadPlaywright();
  if (!playwright) return 2;

  const config = await loadConfig(cwd);

  const { stories, packages } = await scanStories(config, cwd);
  if (stories.length === 0) {
    console.error("No stories found.");
    return 1;
  }

  const resolved = resolveStoryKey(stories, options.story);
  if (!resolved.ok) {
    console.error(`No story matches ${JSON.stringify(options.story)}.`);
    if (resolved.suggestions.length > 0) {
      console.error("\nDid you mean:");
      for (const s of resolved.suggestions) console.error(`  ${s.key}`);
    }
    console.error("\nRun `storybun list` to see every story key.");
    return 1;
  }
  if (!resolved.exact) {
    console.log(`Matched ${resolved.story.key}`);
  }

  const story = stories.find((s) => s.path === resolved.story.path)!;
  const viewport = options.viewport ?? config.snapshot.viewports[0]!;
  const outPath = options.out
    ? isAbsolute(options.out)
      ? options.out
      : resolve(cwd, options.out)
    : defaultOutPath(resolved.story.key, cwd);

  // Only the named story is bundled, so build cost tracks one story's import
  // graph rather than the whole suite's. The full package map is still passed
  // so wrapper and plugin resolution match a full snapshot run exactly.
  const buildResult = await buildSnapshotEntry([story], packages, config, cwd);
  const server = startSnapshotServer(buildResult);

  try {
    const browser = await playwright.chromium.launch();
    try {
      const buffer = await captureOne(
        browser,
        { ...config.snapshot, outDir: join(cwd, config.snapshot.outDir) },
        `http://localhost:${server.port}`,
        {
          storyKey: resolved.story.key,
          viewport,
          fullPage: options.fullPage,
        },
      );

      await Bun.write(outPath, buffer);
      const { width, height } = pngSize(buffer);
      console.log(`${outPath} (${width}x${height})`);
    } finally {
      await browser.close();
    }
  } finally {
    server.stop();
  }

  return 0;
}
