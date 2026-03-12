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
}

export interface StorybunConfig {
  stories?: string[];
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
}

export interface ResolvedConfig {
  stories: string[];
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
