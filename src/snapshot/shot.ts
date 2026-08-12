import { isAbsolute, join, resolve } from "path";
import { loadConfig } from "../config.ts";
import { scanStories } from "../scanner.ts";
import { resolveStoryKey } from "../story-keys.ts";
import type { SnapshotMode } from "../types.ts";
import { buildSnapshotEntry } from "./entry.ts";
import { startSnapshotServer } from "./server.ts";
import { captureOne } from "./capture.ts";
import { loadPlaywright } from "./playwright.ts";

export interface ShotCommandOptions {
  story: string;
  out?: string;
  viewport?: { width: number; height: number };
  /** Name of a configured snapshot mode. Unset picks the first configured one, if any. */
  mode?: string;
}

/** Read width and height straight out of the PNG IHDR chunk. */
function pngSize(buffer: Buffer): { width: number; height: number } {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// Mirrors the baseline naming: the mode suffix is appended only when a mode
// is in effect, so shooting `light` and `dark` in turn does not overwrite one
// file with the other, and a project without modes keeps the bare key.
function defaultOutPath(
  storyKey: string,
  modeName: string | undefined,
  cwd: string,
): string {
  const suffix = modeName === undefined ? "" : `-${modeName}`;
  return join(cwd, `${storyKey.replace(/\//g, "--")}${suffix}.png`);
}

export type ShotModeResult =
  | { ok: true; name: string | undefined; mode: SnapshotMode | undefined }
  | { ok: false; message: string };

/**
 * Pick the mode a shot is taken in.
 *
 * An explicit name must be a configured mode: a typo would otherwise silently
 * produce the browser-default render, which for a dark-themed project is
 * exactly the picture the user did not ask for. Omitted, the first configured
 * mode wins -- the same "first configured" default as `--viewport` -- so that
 * a shot shows what the baseline run sees. No configured modes means no mode,
 * just as `captureAll` captures unsuffixed in that case.
 */
export function resolveShotMode(
  modes: Record<string, SnapshotMode>,
  requested: string | undefined,
): ShotModeResult {
  const names = Object.keys(modes);

  if (requested === undefined) {
    const name = names[0];
    return { ok: true, name, mode: name === undefined ? undefined : modes[name] };
  }

  if (names.length === 0) {
    return {
      ok: false,
      message: `--mode ${JSON.stringify(requested)} given, but no snapshot modes are configured. Add \`snapshot.modes\` to storybun.config.ts or drop the flag.`,
    };
  }

  if (!Object.hasOwn(modes, requested)) {
    return {
      ok: false,
      message: `No snapshot mode named ${JSON.stringify(requested)}. Configured modes: ${names.join(", ")}.`,
    };
  }

  return { ok: true, name: requested, mode: modes[requested] };
}

/**
 * Capture one story to an arbitrary path.
 *
 * Deliberately separate from `runSnapshots`: this writes exactly where it is
 * told and never reads, adopts, or rewrites a baseline, so asking for a picture
 * of a component cannot quietly commit a new expectation to `outDir`. The page
 * environment -- frozen clock, timezone, locale, mode, wrappers -- and the crop
 * are the snapshot environment, so what you see here is what the baseline run
 * sees.
 */
export async function runShot(
  cwd: string,
  options: ShotCommandOptions,
): Promise<number> {
  const playwright = await loadPlaywright();
  if (!playwright) return 2;

  const config = await loadConfig(cwd);

  const modeResult = resolveShotMode(config.snapshot.modes, options.mode);
  if (!modeResult.ok) {
    console.error(modeResult.message);
    return 1;
  }

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
    : defaultOutPath(resolved.story.key, modeResult.name, cwd);

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
          mode: modeResult.mode,
        },
      );

      await Bun.write(outPath, buffer);
      const { width, height } = pngSize(buffer);
      const modeNote = modeResult.name === undefined ? "" : `, ${modeResult.name}`;
      console.log(`${outPath} (${width}x${height}${modeNote})`);
    } finally {
      await browser.close();
    }
  } finally {
    server.stop();
  }

  return 0;
}
