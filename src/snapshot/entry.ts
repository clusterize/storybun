import { join, basename } from "path";
import { tmpdir } from "os";
import type { StoryEntry, PackageInfo, ResolvedConfig } from "../types.ts";
import { findReactResolveDir, createReactPlugin } from "../build-utils.ts";

const DEFAULT_WRAPPER = join(import.meta.dir, "..", "ui", "Wrapper.tsx");

function resolveWrapper(
  pkg: PackageInfo,
  config: ResolvedConfig,
  cwd: string,
): string {
  if (pkg.config.components.Wrapper) {
    return join(pkg.dir, pkg.config.components.Wrapper);
  }
  if (config.components.Wrapper) {
    return join(cwd, config.components.Wrapper);
  }
  return DEFAULT_WRAPPER;
}

export function generateSnapshotEntry(
  stories: StoryEntry[],
  packages: Map<string, PackageInfo>,
  config: ResolvedConfig,
  cwd: string,
): string {
  const moduleEntries = stories
    .map(
      (s) =>
        `  ${JSON.stringify(s.path)}: () => import(${JSON.stringify(s.filePath)})`,
    )
    .join(",\n");

  const isMultiPackage = packages.size > 1;

  const defaultWrapperPath = isMultiPackage
    ? (config.components.Wrapper ? join(cwd, config.components.Wrapper) : DEFAULT_WRAPPER)
    : resolveWrapper([...packages.values()][0]!, config, cwd);

  let wrapperImports = "";
  let wrappersDecl = "";
  if (isMultiPackage) {
    const pkgEntries = [...packages.entries()];
    wrapperImports = pkgEntries
      .map(([, pkg], i) => {
        const wp = resolveWrapper(pkg, config, cwd);
        return `import { Wrapper as Wrapper_${i} } from ${JSON.stringify(wp)};`;
      })
      .join("\n");

    const wrappersMapEntries = pkgEntries
      .map(([name], i) => `  ${JSON.stringify(name)}: Wrapper_${i}`)
      .join(",\n");

    wrappersDecl = `\nconst wrappers: Record<string, typeof Wrapper> = {\n${wrappersMapEntries}\n};\n`;
  }

  // Story data with package name for multi-package wrapper resolution
  const storyPkgMap = stories
    .map((s) => `  ${JSON.stringify(s.path)}: ${JSON.stringify(s.packageName)}`)
    .join(",\n");

  return `
import React from "react";
import { createRoot } from "react-dom/client";
import { Wrapper } from ${JSON.stringify(defaultWrapperPath)};
${wrapperImports}

const modules: Record<string, () => Promise<Record<string, any>>> = {
${moduleEntries}
};

const storyPackages: Record<string, string> = {
${storyPkgMap}
};
${wrappersDecl}
// Zero out CSS animations and transitions. The browser context also emulates
// \`prefers-reduced-motion: reduce\`, which is what JavaScript-driven motion
// libraries and consumer stylesheets honour; this rule is the backstop for a
// CSS animation that has no reduced-motion branch of its own, so that it
// finishes instantly instead of keeping the story from ever settling.
const style = document.createElement("style");
style.textContent = "* { animation-duration: 0s !important; transition-duration: 0s !important; }";
document.head.appendChild(style);

// An iframe's \`load\` event does not bubble, but a capturing listener on the
// document still sees it. The settle check consults this set so a frame that
// has not finished loading -- a mail preview rendered into \`srcdoc\`, say --
// holds the capture back; \`contentDocument.readyState\` alone would report the
// initial about:blank document as complete while the real one is still on its
// way. Installed before any story renders, so no frame's load is missed.
const loadedFrames = new WeakSet<object>();
(window as any).__storybunLoadedFrames = loadedFrames;
document.addEventListener(
  "load",
  (event) => {
    const target = event.target as any;
    if (target && target.tagName === "IFRAME") loadedFrames.add(target);
  },
  true,
);

async function renderStory() {
  const params = new URLSearchParams(window.location.search);
  const storyKey = params.get("story");
  if (!storyKey) {
    document.body.textContent = "Missing ?story= param";
    document.body.dataset.storybunError = "true";
    (window as any).__STORYBUN_READY__ = true;
    return;
  }

  // storyKey = "Path--Export"
  const sep = storyKey.lastIndexOf("--");
  if (sep === -1) {
    document.body.textContent = "Invalid story key: " + storyKey;
    document.body.dataset.storybunError = "true";
    (window as any).__STORYBUN_READY__ = true;
    return;
  }

  const storyPath = storyKey.slice(0, sep);
  const exportName = storyKey.slice(sep + 2);

  const loader = modules[storyPath];
  if (!loader) {
    document.body.textContent = "Story not found: " + storyPath;
    document.body.dataset.storybunError = "true";
    (window as any).__STORYBUN_READY__ = true;
    return;
  }

  const mod = await loader();
  const Story = mod[exportName];
  if (!Story) {
    document.body.textContent = "Export not found: " + exportName + " in " + storyPath;
    document.body.dataset.storybunError = "true";
    (window as any).__STORYBUN_READY__ = true;
    return;
  }

  // Resolve wrapper for this story
  let ActiveWrapper = Wrapper;
  ${isMultiPackage ? `
  const pkgName = storyPackages[storyPath];
  if (pkgName && wrappers[pkgName]) {
    ActiveWrapper = wrappers[pkgName];
  }` : ""}

  const root = createRoot(document.getElementById("root")!);
  root.render(
    React.createElement(
      ActiveWrapper,
      null,
      React.createElement("div", { "data-storybun-story": "" }, React.createElement(Story))
    )
  );

  // Signal readiness after paint
  await document.fonts.ready;
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
  (window as any).__STORYBUN_READY__ = true;
}

renderStory().catch((err) => {
  document.body.textContent = "Error: " + err.message;
  document.body.dataset.storybunError = "true";
  (window as any).__STORYBUN_READY__ = true;
});
`;
}

export interface SnapshotBuildResult {
  buildDir: string;
  assets: Map<string, string>;
  html: string;
}

export async function buildSnapshotEntry(
  stories: StoryEntry[],
  packages: Map<string, PackageInfo>,
  config: ResolvedConfig,
  cwd: string,
): Promise<SnapshotBuildResult> {
  const buildDir = join(tmpdir(), `storybun-snapshot-${process.pid}`);
  const virtualPath = join(cwd, "_storybun_snapshot_entry.tsx");
  const virtualEntryCode = generateSnapshotEntry(stories, packages, config, cwd);

  const reactDir = findReactResolveDir(stories, cwd);
  const reactPlugin = createReactPlugin(reactDir);

  const allPackagePlugins = [...packages.values()].flatMap(
    (pkg) => pkg.config.plugins,
  );
  const plugins = [reactPlugin, ...config.plugins, ...allPackagePlugins];

  const result = await Bun.build({
    entrypoints: [virtualPath],
    // @ts-ignore - Bun.build files option for virtual modules
    files: { [virtualPath]: virtualEntryCode },
    target: "browser",
    splitting: true,
    outdir: buildDir,
    minify: false,
    naming: "[dir]/[name]-[hash].[ext]",
    plugins,
  });

  if (!result.success) {
    console.error("Snapshot build failed:");
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error("Snapshot build failed");
  }

  const assets = new Map<string, string>();
  for (const output of result.outputs) {
    const name = basename(output.path);
    assets.set(`/assets/${name}`, output.path);
  }

  const html = generateSnapshotHtml(assets);

  return { buildDir, assets, html };
}

// `data-storybun-snapshot` on <html> is the documented signal that a page is
// a snapshot capture, present before any script runs, so a Wrapper that needs
// to behave differently under capture (disable a live clock, seed a cache)
// tests `document.documentElement.hasAttribute("data-storybun-snapshot")`
// instead of guessing from the URL.
export function generateSnapshotHtml(assets: Map<string, string>): string {
  const cssLinks: string[] = [];
  const jsScripts: string[] = [];

  for (const [urlPath] of assets) {
    if (urlPath.endsWith(".css")) {
      cssLinks.push(`  <link rel="stylesheet" href="${urlPath}">`);
    } else if (urlPath.endsWith(".js")) {
      if (urlPath.includes("_storybun_snapshot_entry")) {
        jsScripts.push(`  <script type="module" src="${urlPath}"></script>`);
      }
    }
  }

  return `<!DOCTYPE html>
<html lang="en" data-storybun-snapshot>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>storybun snapshot</title>
${cssLinks.join("\n")}
</head>
<body>
  <div id="root"></div>
${jsScripts.join("\n")}
</body>
</html>`;
}
