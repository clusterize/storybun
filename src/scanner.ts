import { relative } from "path";
import type { ResolvedConfig, StoryEntry, PackageInfo } from "./types.ts";
import { discoverPackages, clearPackageCache } from "./packages.ts";

const transpiler = new Bun.Transpiler({ loader: "tsx" });

function deriveStoryPath(filePath: string, baseDir: string): string {
  const rel = relative(baseDir, filePath);
  // Remove leading src/ if present
  const withoutSrc = rel.replace(/^src\//, "");
  // Remove file extension and .stories suffix
  const withoutExt = withoutSrc.replace(/\.stories\.(tsx|ts|jsx|js)$/, "");
  // Convert path separators to /
  const parts = withoutExt.split("/");
  // Capitalize each segment
  return parts
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("/");
}

export interface ScanResult {
  stories: StoryEntry[];
  packages: Map<string, PackageInfo>;
}

export async function scanStories(
  config: ResolvedConfig,
  cwd: string,
): Promise<ScanResult> {
  clearPackageCache();
  const seen = new Set<string>();
  const entries: StoryEntry[] = [];

  for (const pattern of config.stories) {
    const glob = new Bun.Glob(pattern);
    for await (const match of glob.scan({ cwd, absolute: true })) {
      // Skip ignored directories
      if (match.includes("node_modules")) continue;
      if (config.ignore.some((dir) => match.includes(`/${dir}/`))) continue;
      // Dedupe across patterns
      if (seen.has(match)) continue;
      seen.add(match);

      const code = await Bun.file(match).text();
      const result = transpiler.scan(code);
      const exportNames = result.exports.filter((e) => e !== "default");

      if (exportNames.length === 0) continue;

      entries.push({
        path: "", // filled in after package discovery
        filePath: match,
        exports: exportNames,
        packageName: "", // filled in by discoverPackages
      });
    }
  }

  // Discover packages and set packageName on each entry
  const packages = await discoverPackages(entries, cwd);

  // Derive paths relative to each story's package dir
  for (const story of entries) {
    const pkg = packages.get(story.packageName)!;
    story.path = deriveStoryPath(story.filePath, pkg.dir);
  }

  // Multi-package: prepend package name to path
  if (packages.size > 1) {
    for (const story of entries) {
      story.path = `${story.packageName}/${story.path}`;
    }
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));

  return { stories: entries, packages };
}
