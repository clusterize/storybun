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

// One shared browser for the whole file instead of one per describe block --
// launching several Chromium instances concurrently is slow and, on a
// resource-constrained CI/sandbox host, can make an unrelated hook time out.
let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
}, 20_000);

afterAll(async () => {
  await browser.close();
}, 20_000);

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

function pixelAt(buffer: Buffer, x: number, y: number): [number, number, number, number] {
  const png = PNG.sync.read(buffer);
  const i = (y * png.width + x) * 4;
  return [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!, png.data[i + 3]!];
}

function everyPixelIs(buffer: Buffer, [r, g, b, a]: [number, number, number, number]): boolean {
  const png = PNG.sync.read(buffer);
  for (let i = 0; i < png.data.length; i += 4) {
    if (
      png.data[i] !== r ||
      png.data[i + 1] !== g ||
      png.data[i + 2] !== b ||
      png.data[i + 3] !== a
    ) {
      return false;
    }
  }
  return true;
}

describe("captureStoryOrPage (real chromium)", () => {
  let serverUrl: string;
  let stopServer: () => void;

  beforeAll(async () => {
    const build = await buildSnapshotEntry(stories, testPackages(), testConfig(), cwd);
    const server = startSnapshotServer(build);
    serverUrl = `http://localhost:${server.port}`;
    stopServer = () => server.stop();
  }, 20_000);

  afterAll(() => {
    stopServer();
  }, 20_000);

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
      return await captureStoryOrPage(page, storyKey);
    } finally {
      await page.close();
    }
  }

  test("captures the story's own marker box, not a raw viewport screenshot", async () => {
    const viewport = { width: 800, height: 600 };
    const buffer = await captureStory("fixtures/narrow--Badge", viewport);
    const { width, height } = pngDimensions(buffer);

    // No CSS shrinks the marker to its content width (that decision was
    // reverted -- a story that genuinely fills its available width now
    // captures full-width, deliberately). This still isn't a raw
    // `page.screenshot()` though: the marker's own box respects the page's
    // default body margin (8px each side in Chromium), so it comes out 16px
    // narrower than the viewport -- proof the marker, not the page, was
    // captured.
    expect(width).toBe(viewport.width - 16);
    expect(width).not.toBe(viewport.width);
    expect(height).toBe(40); // Badge's own content height, unaffected
  }, 15_000);

  test("captures a story taller than the viewport at its full content height", async () => {
    const viewport = { width: 800, height: 400 };
    const buffer = await captureStory("fixtures/tall--Stack", viewport);
    const { width, height } = pngDimensions(buffer);

    expect(width).toBe(viewport.width - 16);
    expect(height).toBe(2000); // 20 rows * 100px -- not truncated to the viewport
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

  test("throws instead of silently falling back when the marker never becomes visible and no known error state was reported", async () => {
    // A hand-built page, not routed through entry.ts: the marker exists but
    // is hidden, and nothing sets document.body.dataset.storybunError -- the
    // exact shape of a story that renders but never becomes visible (e.g.
    // returning null forever). This must NOT be treated like a legitimate
    // entry-reported error state.
    const page: Page = await browser.newPage();
    try {
      await page.setContent(
        `<html><body><div data-storybun-story style="display:none">stuck</div></body></html>`,
      );
      await expect(captureStoryOrPage(page, "stuck-story", 100)).rejects.toThrow();
    } finally {
      await page.close();
    }
  }, 10_000);
});

describe("captureAll (real call site)", () => {
  let serverUrl: string;
  let stopServer: () => void;

  beforeAll(async () => {
    const build = await buildSnapshotEntry(stories, testPackages(), testConfig(), cwd);
    const server = startSnapshotServer(build);
    serverUrl = `http://localhost:${server.port}`;
    stopServer = () => server.stop();
  }, 20_000);

  afterAll(() => {
    stopServer();
  }, 20_000);

  function snapshotConfig(overrides: Partial<ResolvedSnapshotConfig> = {}): ResolvedSnapshotConfig {
    return { ...testConfig().snapshot, ...overrides };
  }

  test("captures the narrow fixture's own marker box through captureAll, not a raw viewport screenshot", async () => {
    const viewport = { width: 800, height: 600 };
    const config = snapshotConfig({ viewports: [viewport], concurrency: 1 });

    const results = await captureAll(browser, [stories[0]!], config, serverUrl);

    expect(results).toHaveLength(1);
    const { width, height } = pngDimensions(results[0]!.buffer);
    expect(width).toBe(viewport.width - 16); // marker box, not fit to content -- see capture.ts's comment
    expect(width).not.toBe(viewport.width);
    expect(height).toBe(40);
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

describe("wrapper preservation", () => {
  let serverUrl: string;
  let stopServer: () => void;

  const wrapperStories: StoryEntry[] = [
    {
      path: "fixtures/wrapper",
      filePath: join(fixturesDir, "wrapper.stories.tsx"),
      exports: ["ContextStory", "CssStory", "ChromeStory"],
      packageName: "wrapper-pkg",
    },
  ];

  function wrapperPackages(): Map<string, PackageInfo> {
    const packages = new Map<string, PackageInfo>();
    packages.set("wrapper-pkg", {
      name: "wrapper-pkg",
      dir: cwd,
      config: {
        plugins: [],
        components: { Wrapper: "src/snapshot/__fixtures__/wrapper.tsx" },
      },
    });
    return packages;
  }

  beforeAll(async () => {
    const build = await buildSnapshotEntry(wrapperStories, wrapperPackages(), testConfig(), cwd);
    const server = startSnapshotServer(build);
    serverUrl = `http://localhost:${server.port}`;
    stopServer = () => server.stop();
  }, 20_000);

  afterAll(() => {
    stopServer();
  }, 20_000);

  async function captureStory(storyKey: string): Promise<Buffer> {
    const page: Page = await browser.newPage();
    try {
      await page.setViewportSize({ width: 800, height: 600 });
      await page.goto(`${serverUrl}/snapshot?story=${encodeURIComponent(storyKey)}`, {
        waitUntil: "networkidle",
      });
      await page.waitForFunction(() => window.__STORYBUN_READY__ === true, {
        timeout: 30_000,
      });
      return await captureStoryOrPage(page, storyKey);
    } finally {
      await page.close();
    }
  }

  test("wrapper-provided React context reaches the story", async () => {
    const buffer = await captureStory("fixtures/wrapper--ContextStory");
    // Green only if ThemeContext.Provider from the wrapper is actually an
    // ancestor of the story; black is the fallback value.
    expect(pixelAt(buffer, 30, 30)).toEqual([0, 255, 0, 255]);
  }, 15_000);

  test("wrapper-provided CSS affects the story's rendered pixels", async () => {
    const buffer = await captureStory("fixtures/wrapper--CssStory");
    // Green only via a stylesheet rule scoped under the wrapper's own
    // ancestor class; black is the story's own inline-style default.
    expect(pixelAt(buffer, 30, 30)).toEqual([0, 200, 0, 255]);
  }, 15_000);

  test("the wrapper's own padding and chrome fall outside the captured region", async () => {
    const buffer = await captureStory("fixtures/wrapper--ChromeStory");
    const { width, height } = pngDimensions(buffer);

    // The story fills 100% of the marker's own available width (704px --
    // the 800px viewport minus the page's 16px body margin and the
    // wrapper's 40px padding on each side) at its own fixed height. If the
    // wrapper's 40px padding, red background, absolutely-positioned button,
    // or toaster leaked into the capture, the dimensions would be larger
    // than the story's own box and/or a pixel would come out red instead of
    // the story's own color.
    expect(width).toBe(800 - 16 - 40 - 40);
    expect(height).toBe(60);
    expect(everyPixelIs(buffer, [10, 20, 30, 255])).toBe(true);
  }, 15_000);
});

describe("renderStory error branches (real chromium)", () => {
  let serverUrl: string;
  let stopServer: () => void;

  const errorStories: StoryEntry[] = [
    {
      path: "fixtures/errors",
      filePath: join(fixturesDir, "narrow.stories.tsx"),
      exports: ["Badge"],
      packageName: "test-pkg",
    },
  ];

  beforeAll(async () => {
    const build = await buildSnapshotEntry(errorStories, testPackages(), testConfig(), cwd);
    const server = startSnapshotServer(build);
    serverUrl = `http://localhost:${server.port}`;
    stopServer = () => server.stop();
  }, 20_000);

  afterAll(() => {
    stopServer();
  }, 20_000);

  async function loadAndGetBodyText(query: string): Promise<string> {
    const page: Page = await browser.newPage();
    try {
      await page.goto(`${serverUrl}/snapshot${query}`, { waitUntil: "networkidle" });
      // A short timeout: if a branch's __STORYBUN_READY__ signal is missing,
      // this must fail fast rather than hang until captureAll's 30s budget.
      await page.waitForFunction(() => window.__STORYBUN_READY__ === true, {
        timeout: 5_000,
      });
      return await page.locator("body").innerText();
    } finally {
      await page.close();
    }
  }

  test("missing ?story= param signals readiness with a clear message", async () => {
    const text = await loadAndGetBodyText("");
    expect(text).toBe("Missing ?story= param");
  }, 10_000);

  test("invalid story key (no '--' separator) signals readiness with a clear message", async () => {
    const text = await loadAndGetBodyText("?story=bad-key");
    expect(text).toBe("Invalid story key: bad-key");
  }, 10_000);

  test("unknown story path signals readiness with a clear message", async () => {
    const text = await loadAndGetBodyText(
      `?story=${encodeURIComponent("fixtures/does-not-exist--Nope")}`,
    );
    expect(text).toBe("Story not found: fixtures/does-not-exist");
  }, 10_000);

  test("unknown export name signals readiness with a clear message", async () => {
    const text = await loadAndGetBodyText(
      `?story=${encodeURIComponent("fixtures/errors--Missing")}`,
    );
    expect(text).toBe("Export not found: Missing in fixtures/errors");
  }, 10_000);
});
