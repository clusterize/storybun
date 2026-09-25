import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { chromium, type Browser, type Page } from "playwright";

import { PNG } from "pngjs";
import { buildSnapshotEntry } from "./entry.ts";
import { startSnapshotServer } from "./server.ts";
import { captureAll, captureOne, captureStoryOrPage } from "./capture.ts";
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
      modes: {},
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
  {
    path: "fixtures/percent",
    filePath: join(fixturesDir, "percent.stories.tsx"),
    exports: ["FullWidth"],
    packageName: "test-pkg",
  },
  {
    path: "fixtures/grid",
    filePath: join(fixturesDir, "grid.stories.tsx"),
    exports: ["TwoColumn"],
    packageName: "test-pkg",
  },
];

const portalStory: StoryEntry = {
  path: "fixtures/portal",
  filePath: join(fixturesDir, "portal.stories.tsx"),
  exports: ["OpenMenu", "PortalOnly", "EmptyPortal"],
  packageName: "test-pkg",
};

const schemeStory: StoryEntry = {
  path: "fixtures/scheme",
  filePath: join(fixturesDir, "scheme.stories.tsx"),
  exports: ["Swatch"],
  packageName: "test-pkg",
};

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

  test("captures the story's own rendered box, not the marker's container-filling box", async () => {
    const viewport = { width: 800, height: 600 };
    const buffer = await captureStory("fixtures/narrow--Badge", viewport);
    const { width, height } = pngDimensions(buffer);

    // The marker div itself always fills its container (it's a plain
    // block-level div with no CSS) -- that's the bug this round fixes. The
    // crop must instead follow the Badge's own fixed 120x40 box, nowhere
    // near the 800-wide viewport it's rendered inside.
    expect(width).toBe(120);
    expect(width).not.toBe(viewport.width);
    expect(height).toBe(40);
  }, 15_000);

  test("captures a story taller than the viewport at its full content height", async () => {
    const viewport = { width: 800, height: 400 };
    const buffer = await captureStory("fixtures/tall--Stack", viewport);
    const { width, height } = pngDimensions(buffer);

    expect(width).toBe(400); // Stack's own fixed width, not the container's
    expect(height).toBe(2000); // 20 rows * 100px -- not truncated to the viewport
    expect(height).not.toBe(viewport.height);
  }, 15_000);

  test("does not collapse a width: 100% story to its content size", async () => {
    const viewport = { width: 800, height: 600 };
    const buffer = await captureStory("fixtures/percent--FullWidth", viewport);
    const { width, height } = pngDimensions(buffer);

    // A `width: fit-content` on the marker (an earlier, reverted attempt at
    // this fix) collapsed a story like this to single-digit pixels. It must
    // instead come out laid out exactly as in production: the full width
    // available to it (the 800px viewport minus Chromium's 8px-each-side
    // default body margin).
    expect(width).toBe(800 - 16);
    expect(height).toBe(50);
  }, 15_000);

  test("does not collapse a grid-template-columns: 1fr 1fr story to a single column", async () => {
    const viewport = { width: 800, height: 600 };
    const buffer = await captureStory("fixtures/grid--TwoColumn", viewport);
    const { width, height } = pngDimensions(buffer);

    expect(width).toBe(800 - 16);
    expect(height).toBe(50);

    // Both columns must actually be present in the captured pixels, not
    // just claimed by the reported width.
    const quarterX = Math.floor(width / 4);
    const threeQuarterX = width - quarterX;
    expect(pixelAt(buffer, quarterX, 25)).toEqual([14, 165, 233, 255]); // left column, #0ea5e9
    expect(pixelAt(buffer, threeQuarterX, 25)).toEqual([34, 197, 94, 255]); // right column, #22c55e
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

  test("throws instead of silently falling back when the marker has no box and nothing was portaled", async () => {
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

  test("throws instead of silently falling back when the marker is visible but its content has no measurable box", async () => {
    // The marker itself has an explicit box (so it passes the `visible`
    // wait), but its only child collapses to zero size -- e.g. a story
    // that renders `null` or an element with no layout box. This must hit
    // the union-of-children measurement's own degenerate-rect check, not
    // silently crop to a zero-size image or fall back to the viewport.
    const page: Page = await browser.newPage();
    try {
      await page.setContent(
        `<html><body><div data-storybun-story style="width:100px;height:100px;"><span style="display:inline-block;width:0;height:0;"></span></div></body></html>`,
      );
      await expect(captureStoryOrPage(page, "degenerate-story", 100)).rejects.toThrow();
    } finally {
      await page.close();
    }
  }, 10_000);
});

describe("captureAll (real call site)", () => {
  let serverUrl: string;
  let stopServer: () => void;

  beforeAll(async () => {
    const build = await buildSnapshotEntry(
      [...stories, schemeStory, portalStory],
      testPackages(),
      testConfig(),
      cwd,
    );
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

  test("captures the narrow fixture's own rendered box through captureAll, not the marker's container-filling box", async () => {
    const viewport = { width: 800, height: 600 };
    const config = snapshotConfig({ viewports: [viewport], concurrency: 1 });

    const results = await captureAll(browser, [stories[0]!], config, serverUrl);

    expect(results).toHaveLength(1);
    const { width, height } = pngDimensions(results[0]!.buffer);
    expect(width).toBe(120); // Badge's own box, not the marker's -- see capture.ts's comment
    expect(width).not.toBe(viewport.width);
    expect(height).toBe(40);
  }, 20_000);

  test("produces exactly one result per story x export x viewport work item", async () => {
    const viewport = { width: 800, height: 600 };
    const config = snapshotConfig({ viewports: [viewport], concurrency: 2 });

    const results = await captureAll(browser, stories, config, serverUrl);

    expect(results).toHaveLength(4);
    const keys = results.map((r) => r.storyKey).sort();
    expect(keys).toEqual([
      "fixtures/grid--TwoColumn",
      "fixtures/narrow--Badge",
      "fixtures/percent--FullWidth",
      "fixtures/tall--Stack",
    ]);
  }, 20_000);

  test("includes content the story portaled to document.body, as an open menu or dialog is", async () => {
    const config = snapshotConfig({ viewports: [{ width: 800, height: 600 }], concurrency: 1 });

    const results = await captureAll(browser, [portalStory], config, serverUrl, "OpenMenu");

    expect(results).toHaveLength(1);
    const buffer = results[0]!.buffer;
    const { width, height } = pngDimensions(buffer);
    // From the trigger's top-left (8,8: Chromium's default body margin) to
    // the portaled box's bottom-right (400,250).
    expect(width).toBe(400 - 8);
    expect(height).toBe(250 - 8);
    expect(pixelAt(buffer, 30, 15)).toEqual([0, 0, 255, 255]); // the trigger
    expect(pixelAt(buffer, 300 - 8 + 50, 200 - 8 + 25)).toEqual([255, 0, 255, 255]); // the portaled box
  }, 20_000);

  test("captures a story that renders only a portal, as a dialog story does", async () => {
    const config = snapshotConfig({ viewports: [{ width: 800, height: 600 }], concurrency: 1 });

    const results = await captureAll(browser, [portalStory], config, serverUrl, "PortalOnly");

    expect(results).toHaveLength(1);
    const buffer = results[0]!.buffer;
    const { width, height } = pngDimensions(buffer);
    expect(width).toBe(100);
    expect(height).toBe(50);
    expect(pixelAt(buffer, 50, 25)).toEqual([255, 0, 255, 255]);
  }, 20_000);

  test("ignores a portaled element with no box", async () => {
    const config = snapshotConfig({ viewports: [{ width: 800, height: 600 }], concurrency: 1 });

    const results = await captureAll(browser, [portalStory], config, serverUrl, "EmptyPortal");

    expect(results).toHaveLength(1);
    const { width, height } = pngDimensions(results[0]!.buffer);
    expect(width).toBe(60);
    expect(height).toBe(30);
  }, 20_000);

  test("without modes, a story is captured once under the unsuffixed filename in the light scheme", async () => {
    const config = snapshotConfig({ outDir: "/out", concurrency: 1 });

    const results = await captureAll(browser, [schemeStory], config, serverUrl);

    expect(results).toHaveLength(1);
    expect(results[0]!.mode).toBeUndefined();
    expect(results[0]!.outputPath).toBe("/out/fixtures--scheme--Swatch.png");
    expect(pixelAt(results[0]!.buffer, 50, 30)).toEqual([255, 0, 0, 255]);
  }, 20_000);

  test("captures a story once per mode, with the emulated color scheme and a mode suffix", async () => {
    const config = snapshotConfig({
      outDir: "/out",
      concurrency: 2,
      modes: { light: { colorScheme: "light" }, dark: { colorScheme: "dark" } },
    });

    const results = await captureAll(browser, [schemeStory], config, serverUrl);

    expect(results).toHaveLength(2);
    const byMode = new Map(results.map((r) => [r.mode, r]));
    expect([...byMode.keys()].sort()).toEqual(["dark", "light"]);

    expect(byMode.get("light")!.outputPath).toBe("/out/fixtures--scheme--Swatch-light.png");
    expect(pixelAt(byMode.get("light")!.buffer, 50, 30)).toEqual([255, 0, 0, 255]);

    expect(byMode.get("dark")!.outputPath).toBe("/out/fixtures--scheme--Swatch-dark.png");
    expect(pixelAt(byMode.get("dark")!.buffer, 50, 30)).toEqual([0, 255, 0, 255]);
  }, 20_000);

  test("puts the viewport suffix before the mode suffix when both axes are configured", async () => {
    const config = snapshotConfig({
      outDir: "/out",
      concurrency: 1,
      viewports: [
        { width: 800, height: 600, name: "desktop" },
        { width: 400, height: 600 },
      ],
      modes: { dark: { colorScheme: "dark" } },
    });

    const results = await captureAll(browser, [schemeStory], config, serverUrl);

    expect(results.map((r) => r.outputPath).sort()).toEqual([
      "/out/fixtures--scheme--Swatch-400x600-dark.png",
      "/out/fixtures--scheme--Swatch-desktop-dark.png",
    ]);
  }, 20_000);

  test("rejects a mode name that cannot be part of a baseline filename", async () => {
    const config = snapshotConfig({ modes: { "dark/blue": { colorScheme: "dark" } } });

    await expect(captureAll(browser, [schemeStory], config, serverUrl)).rejects.toThrow(
      /Invalid snapshot mode name/,
    );
  }, 20_000);
});

describe("captureOne (shot)", () => {
  let serverUrl: string;
  let stopServer: () => void;

  beforeAll(async () => {
    const build = await buildSnapshotEntry(
      [stories[0]!, schemeStory],
      testPackages(),
      testConfig(),
      cwd,
    );
    const server = startSnapshotServer(build);
    serverUrl = `http://localhost:${server.port}`;
    stopServer = () => server.stop();
  }, 20_000);

  afterAll(() => {
    stopServer();
  }, 20_000);

  test("crops to the story's own rendered box, exactly as a baseline would", async () => {
    const buffer = await captureOne(browser, testConfig().snapshot, serverUrl, {
      storyKey: "fixtures/narrow--Badge",
      viewport: { width: 800, height: 600 },
      mode: undefined,
    });

    expect(pngDimensions(buffer)).toEqual({ width: 120, height: 40 });
  }, 20_000);

  test("renders in the light scheme when no mode is given", async () => {
    const buffer = await captureOne(browser, testConfig().snapshot, serverUrl, {
      storyKey: "fixtures/scheme--Swatch",
      viewport: { width: 800, height: 600 },
      mode: undefined,
    });

    expect(pixelAt(buffer, 50, 30)).toEqual([255, 0, 0, 255]);
  }, 20_000);

  test("emulates the given mode's color scheme", async () => {
    const buffer = await captureOne(browser, testConfig().snapshot, serverUrl, {
      storyKey: "fixtures/scheme--Swatch",
      viewport: { width: 800, height: 600 },
      mode: { colorScheme: "dark" },
    });

    expect(pixelAt(buffer, 50, 30)).toEqual([0, 255, 0, 255]);
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
