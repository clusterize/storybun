import { join } from "path";
import type { ResolvedConfig, StorybunConfig } from "./types.ts";

const defaults: ResolvedConfig = {
  stories: ["**/*.stories.tsx"],
  port: 5175,
  plugins: [],
  components: {},
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
    port: userConfig.port ?? defaults.port,
    plugins: userConfig.plugins ?? [],
    components: { ...defaults.components, ...userConfig.components },
  };
}
