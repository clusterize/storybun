import { join } from "path";
import type { ResolvedConfig, ResolvedSnapshotConfig, SnapshotConfig, StorybunConfig } from "./types.ts";

const snapshotDefaults: ResolvedSnapshotConfig = {
  outDir: "__snapshots__",
  threshold: 0.1,
  maxDiffPixels: 0,
  viewports: [{ width: 1280, height: 720 }],
  settleTimeout: 10_000,
  concurrency: 4,
  codeowners: [],
  clock: null,
  timezoneId: "UTC",
  locale: "en-US",
  modes: {},
  report: { component: null },
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

  warnDeprecatedSnapshotOptions(userConfig.snapshot);

  // `waitTimeout` is dropped here rather than spread through: it is
  // deprecated and ignored, and must not end up in the resolved config.
  const { waitTimeout: _ignored, ...snapshot } = userConfig.snapshot ?? {};

  return {
    stories: userConfig.stories ?? defaults.stories,
    ignore: userConfig.ignore ?? defaults.ignore,
    port: userConfig.port ?? defaults.port,
    plugins: userConfig.plugins ?? [],
    components: { ...defaults.components, ...userConfig.components },
    snapshot: {
      ...snapshotDefaults,
      ...snapshot,
      report: { component: snapshot.report?.component ?? null },
    },
  };
}

/**
 * `waitTimeout` was a blind sleep after the ready signal, the knob consumers
 * turned to paper over the readiness gaps the settle contract now closes.
 * It is accepted so an existing config keeps type-checking, and ignored, so
 * a config that still sets it gets told once instead of silently running
 * seconds slower per story than it has to.
 */
export function warnDeprecatedSnapshotOptions(snapshot: SnapshotConfig | undefined): void {
  if (snapshot?.waitTimeout !== undefined && snapshot.waitTimeout > 0) {
    console.warn(
      `[storybun] snapshot.waitTimeout (${snapshot.waitTimeout}ms) is deprecated and ignored: captures now wait for the story to settle instead of sleeping. Remove it from storybun.config.ts.`,
    );
  }
}
