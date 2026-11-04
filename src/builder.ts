import { join, basename } from "path";
import { tmpdir } from "os";
import type { ResolvedConfig, StoryEntry, PackageInfo } from "./types.ts";
import { findReactResolveDir, createReactPlugin } from "./build-utils.ts";
import { colorSchemeScript } from "./ui/color-scheme.ts";

const STORYBUN_UI = join(import.meta.dir, "ui", "index.tsx");
const STORYBUN_FRAME = join(import.meta.dir, "ui", "Frame.tsx");
const STORYBUN_CSS = join(import.meta.dir, "ui", "styles.css");
const DEFAULT_LAYOUT = join(import.meta.dir, "ui", "Layout.tsx");
const DEFAULT_SIDEBAR = join(import.meta.dir, "ui", "Sidebar.tsx");
const DEFAULT_WRAPPER = join(import.meta.dir, "ui", "Wrapper.tsx");

/** Entry names; the built files are named after them, which is how assets are told apart. */
const SHELL_ENTRY = "_storybun_entry";
const FRAME_ENTRY = "_storybun_frame";

export interface BuildResult {
  buildDir: string;
  assets: Map<string, string>; // url path → absolute file path
  /** The dev UI: sidebar, toolbar and the story iframe(s). */
  html: string;
  /** The page inside the iframe: one story, its Wrapper and the project's CSS. */
  frameHtml: string;
}

/**
 * The shell: storybun's own UI and the story list, nothing of the project.
 * No Wrapper and no story module is imported here, so the project's global
 * CSS never reaches the sidebar.
 */
function generateShellEntry(stories: StoryEntry[], config: ResolvedConfig, cwd: string): string {
  const layoutPath = config.components.Layout ? join(cwd, config.components.Layout) : DEFAULT_LAYOUT;
  const sidebarPath = config.components.Sidebar ? join(cwd, config.components.Sidebar) : DEFAULT_SIDEBAR;
  const storyData = JSON.stringify(stories.map((s) => ({ path: s.path, exports: s.exports })));

  return `
import { render } from ${JSON.stringify(STORYBUN_UI)};
import ${JSON.stringify(STORYBUN_CSS)};
import { Layout } from ${JSON.stringify(layoutPath)};
import { Sidebar } from ${JSON.stringify(sidebarPath)};

render(document.getElementById("root")!, {
  stories: ${storyData},
  components: { Layout, Sidebar },
  modes: ${JSON.stringify(config.snapshot.modes)},
  viewports: ${JSON.stringify(config.snapshot.viewports)},
  frameUrl: "/frame.html",
});
`;
}

/** The frame: the Wrapper(s) and a lazy import per story file. */
function generateFrameEntry(
  stories: StoryEntry[],
  packages: Map<string, PackageInfo>,
  config: ResolvedConfig,
  cwd: string,
): string {
  const moduleEntries = stories
    .map((s) => `  ${JSON.stringify(s.path)}: () => import(${JSON.stringify(s.filePath)})`)
    .join(",\n");

  const isMultiPackage = packages.size > 1;

  const defaultWrapperPath = isMultiPackage
    ? config.components.Wrapper
      ? join(cwd, config.components.Wrapper)
      : DEFAULT_WRAPPER
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

    const wrappersMapEntries = pkgEntries.map(([name], i) => `  ${JSON.stringify(name)}: Wrapper_${i}`).join(",\n");

    wrappersDecl = `\nconst wrappers = {\n${wrappersMapEntries}\n};\n`;
  }

  return `
import { renderFrame } from ${JSON.stringify(STORYBUN_FRAME)};
import ${JSON.stringify(STORYBUN_CSS)};
import { Wrapper } from ${JSON.stringify(defaultWrapperPath)};
${wrapperImports}

const modules = {
${moduleEntries}
};
${wrappersDecl}
renderFrame(document.getElementById("root")!, {
  modules,
  Wrapper,${isMultiPackage ? "\n  wrappers," : ""}
});
`;
}

function resolveWrapper(pkg: PackageInfo, config: ResolvedConfig, cwd: string): string {
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

/** The entry's own script and stylesheet(s); split chunks are loaded by `import()`. */
function entryTags(assets: Map<string, string>, entry: string): { css: string; js: string } {
  const css: string[] = [];
  const js: string[] = [];
  for (const [urlPath] of assets) {
    const name = basename(urlPath);
    if (!name.startsWith(`${entry}-`)) continue;
    if (name.endsWith(".css")) css.push(`  <link rel="stylesheet" href="${urlPath}">`);
    else if (name.endsWith(".js")) js.push(`  <script type="module" src="${urlPath}"></script>`);
  }
  return { css: css.join("\n"), js: js.join("\n") };
}

function page(title: string, head: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
${head}
</head>
<body>
  <div id="root"></div>
${body}
</body>
</html>`;
}

const RELOAD_SCRIPT = `
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

function generateShellHtml(assets: Map<string, string>): string {
  const { css, js } = entryTags(assets, SHELL_ENTRY);
  // A rebuild reloads the shell, and with it every frame.
  return page("storybun", css, `${js}\n${RELOAD_SCRIPT}`);
}

function generateFrameHtml(assets: Map<string, string>): string {
  const { css, js } = entryTags(assets, FRAME_ENTRY);
  // The color-scheme shim must run before the bundle: a theme provider may
  // read `matchMedia` once, while its module loads.
  return page("storybun story", `  <script>${colorSchemeScript()}</script>\n${css}`, js);
}

export async function buildAll(
  stories: StoryEntry[],
  packages: Map<string, PackageInfo>,
  config: ResolvedConfig,
  cwd: string,
): Promise<BuildResult> {
  const buildDir = join(tmpdir(), `storybun-${process.pid}`);
  const shellPath = join(cwd, `${SHELL_ENTRY}.tsx`);
  const framePath = join(cwd, `${FRAME_ENTRY}.tsx`);

  const reactDir = findReactResolveDir(stories, cwd);
  const reactPlugin = createReactPlugin(reactDir);

  // Merge plugins: react plugin + root-level + all per-package plugins
  const allPackagePlugins = [...packages.values()].flatMap((pkg) => pkg.config.plugins);
  const plugins = [reactPlugin, ...config.plugins, ...allPackagePlugins];

  const result = await Bun.build({
    entrypoints: [shellPath, framePath],
    // @ts-ignore - Bun.build files option for virtual modules
    files: {
      [shellPath]: generateShellEntry(stories, config, cwd),
      [framePath]: generateFrameEntry(stories, packages, config, cwd),
    },
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

  return { buildDir, assets, html: generateShellHtml(assets), frameHtml: generateFrameHtml(assets) };
}
