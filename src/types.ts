import type { BunPlugin } from "bun";

export interface StoryMeta {
  path: string;
  exports: string[];
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
