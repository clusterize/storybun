#!/usr/bin/env bun

import { loadConfig } from "./config.ts";
import { scanStories } from "./scanner.ts";
import { buildAll } from "./builder.ts";
import { startServer, updateServer } from "./server.ts";
import { watchFiles } from "./watcher.ts";

const cwd = process.cwd();

async function main() {
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
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
