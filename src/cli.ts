#!/usr/bin/env bun

import { loadConfig } from "./config.ts";
import { scanStories } from "./scanner.ts";
import { buildAll } from "./builder.ts";
import { startServer, updateServer } from "./server.ts";
import { watchFiles } from "./watcher.ts";

const cwd = process.cwd();

async function dev() {
  const config = await loadConfig(cwd);
  console.log("Scanning stories...");

  let { stories, packages } = await scanStories(config, cwd);
  console.log(`Found ${stories.length} story file(s) in ${packages.size} package(s)`);

  console.log("Building...");
  let buildResult = await buildAll(stories, packages, config, cwd);

  const server = startServer(buildResult, config.port);
  console.log(`\nstorybun dev server running at http://localhost:${config.port}\n`);

  // Watch for changes
  let rebuilding = false;
  let pendingRebuild = false;

  async function rebuild() {
    rebuilding = true;
    try {
      ({ stories, packages } = await scanStories(config, cwd));
      buildResult = await buildAll(stories, packages, config, cwd);
      updateServer(server, buildResult);
      console.log(`Rebuilt (${stories.length} story files, ${packages.size} packages)`);
    } catch (err) {
      console.error("Rebuild failed:", err);
    } finally {
      rebuilding = false;
      if (pendingRebuild) {
        pendingRebuild = false;
        rebuild();
      }
    }
  }

  watchFiles(cwd, () => {
    if (rebuilding) {
      pendingRebuild = true;
      return;
    }
    rebuild();
  }, config.ignore);
}

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1] && !args[idx + 1]!.startsWith("-")) {
    return args[idx + 1];
  }
  return undefined;
}

function parseViewport(
  value: string | undefined,
): { width: number; height: number } | undefined {
  if (!value) return undefined;
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) {
    console.error(
      `Invalid --viewport ${JSON.stringify(value)}. Expected WIDTHxHEIGHT, e.g. 1280x720.`,
    );
    process.exit(1);
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

async function snapshot(args: string[]) {
  const { runSnapshots } = await import("./snapshot/index.ts");

  const update = args.includes("--update") || args.includes("-u");
  const codeowners = args.includes("--codeowners");
  const filter = flagValue(args, "--filter");

  const exitCode = await runSnapshots(cwd, { update, filter, codeowners });
  process.exit(exitCode);
}

async function list(args: string[]) {
  const { runList } = await import("./list.ts");

  const exitCode = await runList(cwd, {
    json: args.includes("--json"),
    filter: flagValue(args, "--filter"),
  });
  process.exit(exitCode);
}

/** Flags that consume the following argument, so it is not a positional. */
const VALUE_FLAGS = new Set(["--out", "-o", "--viewport", "--filter"]);

function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    out.push(arg);
  }
  return out;
}

async function shot(args: string[]) {
  const { runShot } = await import("./snapshot/shot.ts");

  const story = positionals(args)[0];
  if (!story) {
    console.error(
      "Usage: storybun shot <story-key> [--out file.png] [--viewport 1280x720] [--full-page]\n\n" +
        "Run `storybun list` to see every story key.",
    );
    process.exit(1);
  }

  const exitCode = await runShot(cwd, {
    story,
    out: flagValue(args, "--out") ?? flagValue(args, "-o"),
    viewport: parseViewport(flagValue(args, "--viewport")),
    fullPage: args.includes("--full-page"),
  });
  process.exit(exitCode);
}

function printHelp() {
  console.log(`storybun — a component explorer built on Bun

Usage:
  storybun                       Start the dev server
  storybun snapshot [options]    Capture and compare every story against its baseline
  storybun list [options]        Print every story key
  storybun shot <story> [opts]   Write a PNG of one story, leaving baselines untouched

snapshot options:
  -u, --update       Accept the current render as the new baseline
      --filter <s>   Only stories whose key contains <s>
      --codeowners   Rewrite the CODEOWNERS entry for the snapshot directory

list options:
      --json         Emit JSON objects instead of bare keys
      --filter <s>   Only stories whose key contains <s>

shot options:
  -o, --out <path>       Output file (default: <story-key>.png in the cwd)
      --viewport <WxH>   Viewport size (default: the first configured snapshot viewport)
      --full-page        Capture the full scrollable page rather than the viewport
`);
}

async function main() {
  const command = process.argv[2];
  const args = process.argv.slice(3);

  if (command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return;
  }

  if (command === "snapshot") {
    await snapshot(args);
  } else if (command === "list") {
    await list(args);
  } else if (command === "shot") {
    await shot(args);
  } else {
    await dev();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
