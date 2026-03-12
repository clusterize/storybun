import { join, dirname, basename } from "path";
import type { PackageConfig, PackageInfo, StoryEntry } from "./types.ts";

interface PackageBase {
  name: string;
  dir: string;
}

const packageCache = new Map<string, PackageBase>();

export function clearPackageCache() {
  packageCache.clear();
}

export async function findPackage(
  filePath: string,
  ceiling: string,
): Promise<PackageBase> {
  let dir = dirname(filePath);

  while (dir.length >= ceiling.length) {
    if (packageCache.has(dir)) return packageCache.get(dir)!;

    const pkgPath = join(dir, "package.json");
    try {
      const pkg = await Bun.file(pkgPath).json();
      const result: PackageBase = {
        name: pkg.name ?? basename(dir),
        dir,
      };
      packageCache.set(dir, result);
      return result;
    } catch {
      // No package.json here, keep walking up
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // No package.json found — treat ceiling (cwd) as the package
  const result: PackageBase = { name: basename(ceiling), dir: ceiling };
  packageCache.set(ceiling, result);
  return result;
}

async function loadPackageConfig(packageDir: string): Promise<PackageConfig> {
  const configPath = join(packageDir, "storybun.config.ts");

  let config: Record<string, unknown>;
  try {
    const mod = await import(configPath);
    config = mod.default ?? mod;
  } catch {
    return { plugins: [], components: {} };
  }

  return {
    plugins: (config.plugins as PackageConfig["plugins"]) ?? [],
    components: {
      Wrapper: (config.components as PackageConfig["components"])?.Wrapper,
    },
  };
}

export async function discoverPackages(
  stories: StoryEntry[],
  cwd: string,
): Promise<Map<string, PackageInfo>> {
  const packages = new Map<string, PackageInfo>();

  // Find the package for each story
  for (const story of stories) {
    const pkg = await findPackage(story.filePath, cwd);
    story.packageName = pkg.name;

    if (!packages.has(pkg.name)) {
      const config = await loadPackageConfig(pkg.dir);
      packages.set(pkg.name, {
        name: pkg.name,
        dir: pkg.dir,
        config,
      });
    }
  }

  return packages;
}
