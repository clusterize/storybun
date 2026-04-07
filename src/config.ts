import { join } from "path";
import type { ResolvedConfig, ResolvedSnapshotConfig, StorybunConfig } from "./types.ts";

const snapshotDefaults: ResolvedSnapshotConfig = {
  outDir: "__snapshots__",
  threshold: 0.1,
  viewports: [{ width: 1280, height: 720 }],
  waitTimeout: 0,
  concurrency: 4,
  codeowners: [],
};

const defaults: ResolvedConfig = {
  stories: ["**/*.stories.tsx"],
  ignore: [],
  port: 5175,
  plugins: [],
  components: {},
  snapshot: snapshotDefaults,
};

export async function loadConfig(cwd: string): Promise<ResolvedConfig> {
  const configPath = join(cwd, "storybun.config.ts");

  let userConfig: StorybunConfig;
  try {
    const mod = await import(configPath);
    userConfig = mod.default ?? mod;
  } catch {
    return { ...defaults };
  }

  return {
    stories: userConfig.stories ?? defaults.stories,
    ignore: userConfig.ignore ?? defaults.ignore,
    port: userConfig.port ?? defaults.port,
    plugins: userConfig.plugins ?? [],
    components: { ...defaults.components, ...userConfig.components },
    snapshot: { ...snapshotDefaults, ...userConfig.snapshot },
  };
}
