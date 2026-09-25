import type { BunPlugin } from "bun";

export interface StoryMeta {
  path: string;
  exports: string[];
}

/**
 * One environment a story is captured in, on top of the viewport. A mode
 * changes what the browser reports to the page, never what the story
 * renders on its own: it is how a theme that follows `prefers-color-scheme`
 * gets a dark baseline next to its light one without a story per theme.
 */
export interface SnapshotMode {
  /** Emulated `prefers-color-scheme` for the page. */
  colorScheme?: "light" | "dark" | "no-preference";
  /** Overrides the snapshot-level `locale` for this mode. */
  locale?: string;
  /** Overrides the snapshot-level `timezoneId` for this mode. */
  timezoneId?: string;
}

export interface SnapshotConfig {
  outDir?: string;
  threshold?: number;
  viewports?: { width: number; height: number; name?: string }[];
  waitTimeout?: number;
  concurrency?: number;
  codeowners?: string[];
  /**
   * Instant to freeze the page clock at, as anything `new Date()` parses.
   * `Date.now()` and `new Date()` then return it on every run, so components
   * that read the wall clock render identical pixels instead of diffing
   * against their own baseline. Unset leaves the real clock in place.
   */
  clock?: string | null;
  /** IANA timezone for the page (default: "UTC"). */
  timezoneId?: string;
  /** Locale for the page, driving `Intl` output (default: "en-US"). */
  locale?: string;
  /**
   * Named environments every story is captured in, e.g.
   * `{ light: { colorScheme: "light" }, dark: { colorScheme: "dark" } }`.
   * Each story x viewport is captured once per mode, and the mode name is
   * appended to the baseline filename. Unset captures each story once, with
   * no suffix.
   */
  modes?: Record<string, SnapshotMode>;
}

export interface StorybunConfig {
  stories?: string[];
  ignore?: string[];
  port?: number;
  plugins?: BunPlugin[];
  components?: {
    Layout?: string;
    Sidebar?: string;
    Wrapper?: string;
  };
  snapshot?: SnapshotConfig;
}

export interface ResolvedSnapshotConfig {
  outDir: string;
  threshold: number;
  viewports: { width: number; height: number; name?: string }[];
  waitTimeout: number;
  concurrency: number;
  codeowners: string[];
  clock: string | null;
  timezoneId: string;
  locale: string;
  modes: Record<string, SnapshotMode>;
}

export interface ResolvedConfig {
  stories: string[];
  ignore: string[];
  port: number;
  plugins: BunPlugin[];
  components: {
    Layout?: string;
    Sidebar?: string;
    Wrapper?: string;
  };
  snapshot: ResolvedSnapshotConfig;
}

export interface StoryEntry {
  /** Display path, e.g. "Components/Button" */
  path: string;
  /** Absolute file path */
  filePath: string;
  /** Named export names (excluding "default") */
  exports: string[];
  /** Package name from nearest package.json */
  packageName: string;
}

export interface PackageInfo {
  /** package.json "name" field */
  name: string;
  /** Directory containing the package.json */
  dir: string;
  /** Per-package config from optional storybun.config.ts */
  config: PackageConfig;
}

export interface PackageConfig {
  plugins: BunPlugin[];
  components: {
    Wrapper?: string;
  };
}
