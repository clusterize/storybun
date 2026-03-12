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

function generateSnapshotEntry(
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
// Disable animations for stable snapshots
const style = document.createElement("style");
style.textContent = "* { animation-duration: 0s !important; transition-duration: 0s !important; }";
document.head.appendChild(style);

async function renderStory() {
  const params = new URLSearchParams(window.location.search);
  const storyKey = params.get("story");
  if (!storyKey) {
    document.body.textContent = "Missing ?story= param";
    return;
  }

  // storyKey = "Path--Export"
  const sep = storyKey.lastIndexOf("--");
  if (sep === -1) {
    document.body.textContent = "Invalid story key: " + storyKey;
    return;
  }

  const storyPath = storyKey.slice(0, sep);
  const exportName = storyKey.slice(sep + 2);

  const loader = modules[storyPath];
  if (!loader) {
    document.body.textContent = "Story not found: " + storyPath;
    return;
  }

  const mod = await loader();
  const Story = mod[exportName];
  if (!Story) {
    document.body.textContent = "Export not found: " + exportName + " in " + storyPath;
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
    React.createElement(ActiveWrapper, null, React.createElement(Story))
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

function generateSnapshotHtml(assets: Map<string, string>): string {
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
<html lang="en">
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
