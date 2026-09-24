import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { chromium, type Browser, type Page } from "playwright";
import { PNG } from "pngjs";
import { buildSnapshotEntry } from "./entry.ts";
import { startSnapshotServer } from "./server.ts";
import { captureAll, captureStoryOrPage } from "./capture.ts";
import type { PackageInfo, ResolvedConfig, ResolvedSnapshotConfig, StoryEntry } from "../types.ts";

// tsconfig has no "dom" lib; declare the one global this file touches
// rather than casting through `any` at every use.
declare const window: any;

const cwd = join(import.meta.dir, "..", "..");
const fixturesDir = join(import.meta.dir, "__fixtures__");

function testConfig(): ResolvedConfig {
  return {
    stories: [],
    ignore: [],
    port: 0,
    plugins: [],
    components: {},
    snapshot: {
      outDir: "__snapshots__",
      threshold: 0.1,
      viewports: [{ width: 800, height: 600 }],
      waitTimeout: 0,
      concurrency: 1,
      codeowners: [],
      clock: null,
      timezoneId: "UTC",
      locale: "en-US",
    },
  };
}

function testPackages(): Map<string, PackageInfo> {
  const packages = new Map<string, PackageInfo>();
  packages.set("test-pkg", {
    name: "test-pkg",
    dir: cwd,
    config: { plugins: [], components: {} },
  });
  return packages;
}

const stories: StoryEntry[] = [
  {
    path: "fixtures/narrow",
    filePath: join(fixturesDir, "narrow.stories.tsx"),
    exports: ["Badge"],
    packageName: "test-pkg",
  },
  {
    path: "fixtures/tall",
    filePath: join(fixturesDir, "tall.stories.tsx"),
    exports: ["Stack"],
    packageName: "test-pkg",
  },
];

function pngDimensions(buffer: Buffer): { width: number; height: number } {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height };
}

describe("captureStoryOrPage (real chromium)", () => {
  let browser: Browser;
  let serverUrl: string;
  let stopServer: () => void;

  beforeAll(async () => {
    browser = await chromium.launch();

    const build = await buildSnapshotEntry(stories, testPackages(), testConfig(), cwd);
    const server = startSnapshotServer(build);
    serverUrl = `http://localhost:${server.port}`;
    stopServer = () => server.stop();
  });

  afterAll(async () => {
    stopServer();
    await browser.close();
  });

  async function captureStory(
    storyKey: string,
    viewport: { width: number; height: number },
  ): Promise<Buffer> {
    const page: Page = await browser.newPage();
    try {
      await page.setViewportSize(viewport);
      await page.goto(`${serverUrl}/snapshot?story=${encodeURIComponent(storyKey)}`, {
        waitUntil: "networkidle",
      });
      await page.waitForFunction(() => window.__STORYBUN_READY__ === true, {
        timeout: 30_000,
      });
      return await captureStoryOrPage(page);
    } finally {
      await page.close();
    }
  }

  test("crops a narrow story to its own box, not the viewport", async () => {
    const viewport = { width: 800, height: 600 };
    const buffer = await captureStory("fixtures/narrow--Badge", viewport);
    const { width, height } = pngDimensions(buffer);

    expect(width).toBe(120);
    expect(height).toBe(40);
    expect(width).not.toBe(viewport.width);
  }, 15_000);

  test("captures a story taller than the viewport at its full content height", async () => {
    const viewport = { width: 800, height: 400 };
    const buffer = await captureStory("fixtures/tall--Stack", viewport);
    const { width, height } = pngDimensions(buffer);

    expect(width).toBe(400);
    expect(height).toBe(2000); // 20 rows * 100px
    expect(height).not.toBe(viewport.height);
  }, 15_000);

  test("falls back to a full-page screenshot when no marker is present", async () => {
    const viewport = { width: 800, height: 600 };
    // Unknown story path -> entry.ts's "Story not found" error path, which
    // never mounts the marker.
    const buffer = await captureStory("fixtures/does-not-exist--Nope", viewport);
    const { width, height } = pngDimensions(buffer);

    expect(width).toBe(viewport.width);
    expect(height).toBe(viewport.height);
  }, 15_000);
});

describe("captureAll (real call site)", () => {
  let browser: Browser;
  let serverUrl: string;
  let stopServer: () => void;

  beforeAll(async () => {
    browser = await chromium.launch();

    const build = await buildSnapshotEntry(stories, testPackages(), testConfig(), cwd);
    const server = startSnapshotServer(build);
    serverUrl = `http://localhost:${server.port}`;
    stopServer = () => server.stop();
  });

  afterAll(async () => {
    stopServer();
    await browser.close();
  });

  function snapshotConfig(overrides: Partial<ResolvedSnapshotConfig> = {}): ResolvedSnapshotConfig {
    return { ...testConfig().snapshot, ...overrides };
  }

  test("crops the narrow fixture to its own box through captureAll, not the viewport", async () => {
    const viewport = { width: 800, height: 600 };
    const config = snapshotConfig({ viewports: [viewport], concurrency: 1 });

    const results = await captureAll(browser, [stories[0]!], config, serverUrl);

    expect(results).toHaveLength(1);
    const { width, height } = pngDimensions(results[0]!.buffer);
    expect(width).toBe(120);
    expect(height).toBe(40);
    expect(width).not.toBe(viewport.width);
  }, 20_000);

  test("produces exactly one result per story x export x viewport work item", async () => {
    const viewport = { width: 800, height: 600 };
    const config = snapshotConfig({ viewports: [viewport], concurrency: 2 });

    const results = await captureAll(browser, stories, config, serverUrl);

    expect(results).toHaveLength(2);
    const keys = results.map((r) => r.storyKey).sort();
    expect(keys).toEqual(["fixtures/narrow--Badge", "fixtures/tall--Stack"]);
  }, 20_000);
});
