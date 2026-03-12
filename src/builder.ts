import { join, basename } from "path";
import { tmpdir } from "os";
import type { ResolvedConfig, StoryEntry, PackageInfo } from "./types.ts";
import { findReactResolveDir, createReactPlugin } from "./build-utils.ts";

const STORYBUN_UI = join(import.meta.dir, "ui", "index.tsx");
const STORYBUN_CSS = join(import.meta.dir, "ui", "styles.css");
const DEFAULT_LAYOUT = join(import.meta.dir, "ui", "Layout.tsx");
const DEFAULT_SIDEBAR = join(import.meta.dir, "ui", "Sidebar.tsx");
const DEFAULT_WRAPPER = join(import.meta.dir, "ui", "Wrapper.tsx");

export interface BuildResult {
  buildDir: string;
  assets: Map<string, string>; // url path → absolute file path
  html: string;
}

function generateVirtualEntry(
  stories: StoryEntry[],
  packages: Map<string, PackageInfo>,
  config: ResolvedConfig,
  cwd: string,
): string {
  const layoutPath = config.components.Layout
    ? join(cwd, config.components.Layout)
    : DEFAULT_LAYOUT;
  const sidebarPath = config.components.Sidebar
    ? join(cwd, config.components.Sidebar)
    : DEFAULT_SIDEBAR;

  const storyData = JSON.stringify(
    stories.map((s) => ({ path: s.path, exports: s.exports })),
  );

  const moduleEntries = stories
    .map(
      (s) =>
        `  ${JSON.stringify(s.path)}: () => import(${JSON.stringify(s.filePath)})`,
    )
    .join(",\n");

  const isMultiPackage = packages.size > 1;

  // Resolve default Wrapper
  const defaultWrapperPath = isMultiPackage
    ? (config.components.Wrapper ? join(cwd, config.components.Wrapper) : DEFAULT_WRAPPER)
    : resolveWrapper([...packages.values()][0]!, config, cwd);

  // Multi-package: import each package's Wrapper with index-based aliases
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

    wrappersDecl = `\nconst wrappers = {\n${wrappersMapEntries}\n};\n`;
  }

  return `
import { render } from ${JSON.stringify(STORYBUN_UI)};
import ${JSON.stringify(STORYBUN_CSS)};
import { Layout } from ${JSON.stringify(layoutPath)};
import { Sidebar } from ${JSON.stringify(sidebarPath)};
import { Wrapper } from ${JSON.stringify(defaultWrapperPath)};
${wrapperImports}

const storyData = ${storyData};

const modules = {
${moduleEntries}
};
${wrappersDecl}
render(document.getElementById("root")!, {
  stories: storyData,
  modules,
  components: { Layout, Sidebar, Wrapper },${isMultiPackage ? "\n  wrappers," : ""}
});
`;
}

function resolveWrapper(
  pkg: PackageInfo,
  config: ResolvedConfig,
  cwd: string,
): string {
  // Per-package Wrapper takes priority
  if (pkg.config.components.Wrapper) {
    return join(pkg.dir, pkg.config.components.Wrapper);
  }
  // Fall back to root config Wrapper
  if (config.components.Wrapper) {
    return join(cwd, config.components.Wrapper);
  }
  // Built-in default
  return DEFAULT_WRAPPER;
}

function generateHtml(assets: Map<string, string>): string {
  const cssLinks: string[] = [];
  const jsScripts: string[] = [];

  for (const [urlPath] of assets) {
    if (urlPath.endsWith(".css")) {
      cssLinks.push(`  <link rel="stylesheet" href="${urlPath}">`);
    } else if (urlPath.endsWith(".js")) {
      // Only include the entry chunk, not split chunks (they're loaded by import())
      if (urlPath.includes("_storybun_entry")) {
        jsScripts.push(`  <script type="module" src="${urlPath}"></script>`);
      }
    }
  }

  const wsScript = `
  <script>
    (function() {
      var ws = new WebSocket("ws://" + location.host + "/__storybun_ws");
      ws.onmessage = function(e) {
        if (e.data === "reload") location.reload();
      };
      ws.onclose = function() {
        setTimeout(function() { location.reload(); }, 1000);
      };
    })();
  </script>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>storybun</title>
${cssLinks.join("\n")}
</head>
<body>
  <div id="root"></div>
${jsScripts.join("\n")}
${wsScript}
</body>
</html>`;
}

export async function buildAll(
  stories: StoryEntry[],
  packages: Map<string, PackageInfo>,
  config: ResolvedConfig,
  cwd: string,
): Promise<BuildResult> {
  const buildDir = join(tmpdir(), `storybun-${process.pid}`);
  const virtualPath = join(cwd, "_storybun_entry.tsx");
  const virtualEntryCode = generateVirtualEntry(stories, packages, config, cwd);

  const reactDir = findReactResolveDir(stories, cwd);
  const reactPlugin = createReactPlugin(reactDir);

  // Merge plugins: react plugin + root-level + all per-package plugins
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
    console.error("Build failed:");
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error("Build failed");
  }

  const assets = new Map<string, string>();
  for (const output of result.outputs) {
    const name = basename(output.path);
    assets.set(`/assets/${name}`, output.path);
  }

  const html = generateHtml(assets);

  return { buildDir, assets, html };
}
