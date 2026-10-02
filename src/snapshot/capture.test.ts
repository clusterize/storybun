import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { chromium, type Browser, type Page } from "playwright";

import { PNG } from "pngjs";
import { buildSnapshotEntry } from "./entry.ts";
import { startSnapshotServer } from "./server.ts";
import { captureAll, captureOne, captureStoryOrPage, renderStory } from "./capture.ts";
import { FROZEN_AT } from "./__fixtures__/clock.stories.tsx";
import type { PackageInfo, ResolvedConfig, ResolvedSnapshotConfig, StoryEntry } from "../types.ts";
import type { CaptureHooks } from "./progress.ts";

// tsconfig has no "dom" lib; declare the globals this file touches rather
// than casting through `any` at every use.
declare const window: any;
declare const document: any;

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
      maxDiffPixels: 0,
      viewports: [{ width: 800, height: 600 }],
      settleTimeout: 2_000,
      concurrency: 1,
      codeowners: [],
      clock: null,
      timezoneId: "UTC",
      locale: "en-US",
      modes: {},
      report: { component: null },
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

const emptyStory: StoryEntry = {
  path: "fixtures/empty",
  filePath: join(fixturesDir, "empty.stories.tsx"),
  exports: ["Nothing"],
  packageName: "test-pkg",
};

const portalStory: StoryEntry = {
  path: "fixtures/portal",
  filePath: join(fixturesDir, "portal.stories.tsx"),
  exports: ["OpenMenu", "PortalOnly", "EmptyPortal", "FixedBanner", "FixedContainer", "NestedPortal"],
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

// `captureAll` hands each capture's pixels to `onCapture` and keeps only
// the dimensions; these tests look at pixels, so the hook collects them.
async function captureAllWithBuffers(
  b: Browser,
  storyList: StoryEntry[],
  config: ResolvedSnapshotConfig,
  url: string,
  filter?: string,
  hooks: CaptureHooks = {},
) {
  const buffers = new Map<string, Buffer>();
  const outcome = await captureAll(b, storyList, config, url, filter, {
    ...hooks,
    onCapture: async (c) => {
      buffers.set(c.outputPath, c.buffer);
      return hooks.onCapture?.(c);
    },
  });
  return {
    ...outcome,
    captures: outcome.captures.map((c) => ({ ...c, buffer: buffers.get(c.outputPath)! })),
  };
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
      await expect(captureStoryOrPage(page, "stuck-story", { markerTimeoutMs: 100 })).rejects.toThrow();
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
      await expect(captureStoryOrPage(page, "degenerate-story", { markerTimeoutMs: 100 })).rejects.toThrow();
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
      [...stories, schemeStory, emptyStory, portalStory],
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

    const { captures: results } = await captureAllWithBuffers(browser, [stories[0]!], config, serverUrl);

    expect(results).toHaveLength(1);
    const { width, height } = pngDimensions(results[0]!.buffer);
    expect(width).toBe(120); // Badge's own box, not the marker's -- see capture.ts's comment
    expect(width).not.toBe(viewport.width);
    expect(height).toBe(40);
  }, 20_000);

  test("produces exactly one result per story x export x viewport work item", async () => {
    const viewport = { width: 800, height: 600 };
    const config = snapshotConfig({ viewports: [viewport], concurrency: 2 });

    const { captures: results } = await captureAllWithBuffers(browser, stories, config, serverUrl);

    expect(results).toHaveLength(4);
    const keys = results.map((r) => r.storyKey).sort();
    expect(keys).toEqual([
      "fixtures/grid--TwoColumn",
      "fixtures/narrow--Badge",
      "fixtures/percent--FullWidth",
      "fixtures/tall--Stack",
    ]);
  }, 20_000);

  test("keeps capturing after a story that cannot be captured, and reports it", async () => {
    const config = snapshotConfig({ viewports: [{ width: 800, height: 600 }], concurrency: 1 });

    const { captures, failures } = await captureAllWithBuffers(
      browser,
      [emptyStory, stories[0]!],
      config,
      serverUrl,
    );

    expect(captures.map((c) => c.storyKey)).toEqual(["fixtures/narrow--Badge"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.storyKey).toBe("fixtures/empty--Nothing");
    expect(failures[0]!.error).toBeInstanceOf(Error);
  }, 30_000);

  test("reports each finished capture through the progress hooks, failures included", async () => {
    const config = snapshotConfig({ viewports: [{ width: 800, height: 600 }], concurrency: 2 });
    const totals: number[] = [];
    const events: { index: number; storyKey: string; failed: boolean; durationMs: number }[] = [];

    await captureAllWithBuffers(browser, [emptyStory, stories[0]!, stories[1]!], config, serverUrl, undefined, {
      onStart: (total) => totals.push(total),
      onProgress: (e) => events.push({ index: e.index, storyKey: e.storyKey, failed: !!e.error, durationMs: e.durationMs }),
    });

    expect(totals).toEqual([3]);
    expect(events.map((e) => e.index)).toEqual([1, 2, 3]);
    expect(events.map((e) => e.storyKey).sort()).toEqual([
      "fixtures/empty--Nothing",
      "fixtures/narrow--Badge",
      "fixtures/tall--Stack",
    ]);
    expect(events.find((e) => e.storyKey === "fixtures/empty--Nothing")!.failed).toBe(true);
    expect(events.filter((e) => e.failed)).toHaveLength(1);
    for (const e of events) expect(e.durationMs).toBeGreaterThan(0);
  }, 30_000);

  test("includes content the story portaled to document.body, as an open menu or dialog is", async () => {
    const config = snapshotConfig({ viewports: [{ width: 800, height: 600 }], concurrency: 1 });

    const { captures: results } = await captureAllWithBuffers(
      browser,
      [portalStory],
      config,
      serverUrl,
      "OpenMenu",
    );

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

  test("includes a popup positioned inside a portal container that has no box itself", async () => {
    const config = snapshotConfig({ viewports: [{ width: 800, height: 600 }], concurrency: 1 });

    const { captures } = await captureAllWithBuffers(browser, [portalStory], config, serverUrl, "NestedPortal");

    expect(captures).toHaveLength(1);
    const buffer = captures[0]!.buffer;
    const { width, height } = pngDimensions(buffer);
    expect(width).toBe(400 - 8);
    expect(height).toBe(250 - 8);
    expect(pixelAt(buffer, 300 - 8 + 50, 200 - 8 + 25)).toEqual([255, 0, 255, 255]);
  }, 20_000);

  test("includes a fixed-position descendant of the story, as a toast is", async () => {
    const config = snapshotConfig({ viewports: [{ width: 800, height: 600 }], concurrency: 1 });

    const { captures } = await captureAllWithBuffers(browser, [portalStory], config, serverUrl, "FixedBanner");

    expect(captures).toHaveLength(1);
    const buffer = captures[0]!.buffer;
    const { width, height } = pngDimensions(buffer);
    expect(width).toBe(400 - 8);
    expect(height).toBe(250 - 8);
    expect(pixelAt(buffer, 30, 15)).toEqual([0, 0, 255, 255]);
    expect(pixelAt(buffer, 300 - 8 + 50, 200 - 8 + 25)).toEqual([255, 0, 255, 255]);
  }, 20_000);

  test("includes an item positioned inside a fixed container that has no height, as a toast is", async () => {
    const config = snapshotConfig({ viewports: [{ width: 800, height: 600 }], concurrency: 1 });

    const { captures } = await captureAllWithBuffers(browser, [portalStory], config, serverUrl, "FixedContainer");

    expect(captures).toHaveLength(1);
    const buffer = captures[0]!.buffer;
    const { width, height } = pngDimensions(buffer);
    expect(width).toBe(400 - 8);
    expect(height).toBe(250 - 8);
    expect(pixelAt(buffer, 300 - 8 + 50, 200 - 8 + 25)).toEqual([255, 0, 255, 255]);
  }, 20_000);

  test("captures a story that renders only a portal, as a dialog story does", async () => {
    const config = snapshotConfig({ viewports: [{ width: 800, height: 600 }], concurrency: 1 });

    const { captures: results } = await captureAllWithBuffers(
      browser,
      [portalStory],
      config,
      serverUrl,
      "PortalOnly",
    );

    expect(results).toHaveLength(1);
    const buffer = results[0]!.buffer;
    const { width, height } = pngDimensions(buffer);
    expect(width).toBe(100);
    expect(height).toBe(50);
    expect(pixelAt(buffer, 50, 25)).toEqual([255, 0, 255, 255]);
  }, 20_000);

  test("ignores a portaled element with no box", async () => {
    const config = snapshotConfig({ viewports: [{ width: 800, height: 600 }], concurrency: 1 });

    const { captures: results } = await captureAllWithBuffers(
      browser,
      [portalStory],
      config,
      serverUrl,
      "EmptyPortal",
    );

    expect(results).toHaveLength(1);
    const { width, height } = pngDimensions(results[0]!.buffer);
    expect(width).toBe(60);
    expect(height).toBe(30);
  }, 20_000);

  test("without modes, a story is captured once under the unsuffixed filename in the light scheme", async () => {
    const config = snapshotConfig({ outDir: "/out", concurrency: 1 });

    const { captures: results } = await captureAllWithBuffers(browser, [schemeStory], config, serverUrl);

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

    const { captures: results } = await captureAllWithBuffers(browser, [schemeStory], config, serverUrl);

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

    const { captures: results } = await captureAllWithBuffers(browser, [schemeStory], config, serverUrl);

    expect(results.map((r) => r.outputPath).sort()).toEqual([
      "/out/fixtures--scheme--Swatch-400x600-dark.png",
      "/out/fixtures--scheme--Swatch-desktop-dark.png",
    ]);
  }, 20_000);

  test("hands each capture's pixels to onCapture and keeps only its dimensions", async () => {
    const config = snapshotConfig({ viewports: [{ width: 800, height: 600 }], concurrency: 1 });
    const seen: { storyKey: string; bytes: number }[] = [];

    const { captures } = await captureAll(browser, [stories[0]!], config, serverUrl, undefined, {
      onCapture: (c) => {
        seen.push({ storyKey: c.storyKey, bytes: c.buffer.length });
      },
    });

    expect(seen).toEqual([{ storyKey: "fixtures/narrow--Badge", bytes: expect.any(Number) }]);
    expect(seen[0]!.bytes).toBeGreaterThan(0);
    expect(captures).toHaveLength(1);
    expect(captures[0]!.dimensions).toEqual({ width: 120, height: 40 });
    expect("buffer" in captures[0]!).toBe(false);
  }, 20_000);

  test("shows what onCapture returned on the progress line, and a throwing hook fails only its capture", async () => {
    const config = snapshotConfig({ viewports: [{ width: 800, height: 600 }], concurrency: 1 });
    const outcomes = new Map<string, string | undefined>();
    const errors = new Map<string, string | undefined>();

    const { captures, failures } = await captureAll(
      browser,
      [stories[0]!, stories[1]!],
      config,
      serverUrl,
      undefined,
      {
        onCapture: async (c) => {
          if (c.storyKey === "fixtures/tall--Stack") throw new Error("baseline is not a PNG");
          return "+ new";
        },
        onProgress: (e) => {
          outcomes.set(e.storyKey, e.outcome);
          errors.set(e.storyKey, e.error?.message);
        },
      },
    );

    expect(captures.map((c) => c.storyKey)).toEqual(["fixtures/narrow--Badge"]);
    expect(outcomes.get("fixtures/narrow--Badge")).toBe("+ new");
    expect(failures.map((f) => f.storyKey)).toEqual(["fixtures/tall--Stack"]);
    expect(errors.get("fixtures/tall--Stack")).toBe("baseline is not a PNG");
  }, 30_000);

  test("rejects a mode name that cannot be part of a baseline filename", async () => {
    const config = snapshotConfig({ modes: { "dark/blue": { colorScheme: "dark" } } });

    await expect(captureAllWithBuffers(browser, [schemeStory], config, serverUrl)).rejects.toThrow(
      /Invalid snapshot mode name/,
    );
  }, 20_000);
});

describe("readiness contract (real chromium)", () => {
  let serverUrl: string;
  let stopServer: () => void;

  const asyncStory: StoryEntry = {
    path: "fixtures/async",
    filePath: join(fixturesDir, "async.stories.tsx"),
    exports: ["LateContent", "Skeleton", "PendingCounter", "LazyMount", "NeverSettles"],
    packageName: "test-pkg",
  };
  const mediaStory: StoryEntry = {
    path: "fixtures/media",
    filePath: join(fixturesDir, "media.stories.tsx"),
    exports: ["Image", "SrcDocFrame", "SlowFrame", "FrameWithResources"],
    packageName: "test-pkg",
  };
  const motionStory: StoryEntry = {
    path: "fixtures/motion",
    filePath: join(fixturesDir, "motion.stories.tsx"),
    exports: ["FadeIn", "Spinner", "ReducedMotion", "SnapshotFlag"],
    packageName: "test-pkg",
  };
  const clockStory: StoryEntry = {
    path: "fixtures/clock",
    filePath: join(fixturesDir, "clock.stories.tsx"),
    exports: ["First", "Second"],
    packageName: "test-pkg",
  };

  // Any real font file will do for `/slow-font.ttf`; it only has to arrive
  // late. The fixture requests it after its frame's load event, which is
  // exactly the gap under test.
  const SLOW_FONT = new Bun.Glob("node_modules/playwright-core/**/*.ttf").scanSync(cwd).next().value as string;

  /** A solid red 120x80 PNG, what `/slow.png` serves. */
  function redPng(): Buffer {
    const image = new PNG({ width: 120, height: 80 });
    for (let i = 0; i < 120 * 80; i++) {
      image.data[i * 4] = 255;
      image.data[i * 4 + 1] = 0;
      image.data[i * 4 + 2] = 0;
      image.data[i * 4 + 3] = 255;
    }
    return PNG.sync.write(image);
  }

  beforeAll(async () => {
    expect(SLOW_FONT).toBeDefined();
    const build = await buildSnapshotEntry(
      [asyncStory, mediaStory, motionStory, clockStory],
      testPackages(),
      testConfig(),
      cwd,
    );
    const inner = startSnapshotServer(build);
    const red = redPng();
    // Sits in front of the snapshot server to serve two deliberately slow
    // assets, so an image and a framed document arrive well after the
    // entry's ready signal. Everything else is passed through.
    const proxy = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/slow.png") {
          await Bun.sleep(300);
          return new Response(red, { headers: { "Content-Type": "image/png" } });
        }
        if (url.pathname === "/slow-font.ttf") {
          await Bun.sleep(400);
          return new Response(Bun.file(SLOW_FONT), { headers: { "Content-Type": "font/ttf" } });
        }
        if (url.pathname === "/slow.html") {
          await Bun.sleep(300);
          return new Response(`<!doctype html><body style="margin:0;background:#ff00ff"></body>`, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        return fetch(`http://localhost:${inner.port}${url.pathname}${url.search}`);
      },
    });
    serverUrl = `http://localhost:${proxy.port}`;
    stopServer = () => {
      proxy.stop();
      inner.stop();
    };
  }, 20_000);

  afterAll(() => {
    stopServer();
  }, 20_000);

  function snapshotConfig(overrides: Partial<ResolvedSnapshotConfig> = {}): ResolvedSnapshotConfig {
    return { ...testConfig().snapshot, viewports: [{ width: 800, height: 600 }], concurrency: 1, ...overrides };
  }

  async function captureSingle(story: StoryEntry, exportName: string, overrides: Partial<ResolvedSnapshotConfig> = {}) {
    const { captures, failures } = await captureAllWithBuffers(
      browser,
      [{ ...story, exports: [exportName] }],
      snapshotConfig(overrides),
      serverUrl,
    );
    expect(failures).toEqual([]);
    expect(captures).toHaveLength(1);
    return captures[0]!.buffer;
  }

  test("waits for content that arrives after first paint instead of failing on an empty marker", async () => {
    const buffer = await captureSingle(asyncStory, "LateContent");
    expect(pngDimensions(buffer)).toEqual({ width: 200, height: 100 });
    expect(pixelAt(buffer, 100, 50)).toEqual([0, 255, 0, 255]);
  }, 20_000);

  test("captures a skeleton that gives no pending signal as the skeleton -- the limit the counter exists for", async () => {
    // A story that is quiet for two frames and only later swaps its skeleton
    // for data looks settled to every check the page can make on itself. The
    // settle contract is deliberately not a sleep, so this is captured as
    // the skeleton; a Wrapper that reports its in-flight requests through
    // `window.__storybunPending` is what makes the data render the baseline
    // (see the PendingCounter test).
    const buffer = await captureSingle(asyncStory, "Skeleton");
    expect(pngDimensions(buffer)).toEqual({ width: 50, height: 20 });
  }, 20_000);

  test("holds the capture while window.__storybunPending is above zero", async () => {
    // Same size from the first paint; only the counter knows a re-render is coming.
    const buffer = await captureSingle(asyncStory, "PendingCounter");
    expect(pixelAt(buffer, 100, 50)).toEqual([0, 255, 0, 255]);
  }, 20_000);

  test("waits for a lazily mounted component under a null Suspense fallback", async () => {
    const buffer = await captureSingle(asyncStory, "LazyMount");
    expect(pngDimensions(buffer)).toEqual({ width: 200, height: 100 });
    expect(pixelAt(buffer, 100, 50)).toEqual([0, 255, 0, 255]);
  }, 20_000);

  test("the ready signal alone fires while an image is still loading", async () => {
    // The gap the contract closes: with `load` plus the entry's ready flag,
    // the image has not arrived. If this ever passes without the settle
    // wait, the image test below proves nothing.
    const page: Page = await browser.newPage();
    try {
      await page.goto(`${serverUrl}/snapshot?story=${encodeURIComponent("fixtures/media--Image")}`, {
        waitUntil: "load",
      });
      await page.waitForFunction(() => window.__STORYBUN_READY__ === true, { timeout: 30_000 });
      const complete = await page.evaluate(() => document.images[0].complete);
      expect(complete).toBe(false);
    } finally {
      await page.close();
    }
  }, 20_000);

  test("waits for every image to load and decode", async () => {
    const buffer = await captureSingle(mediaStory, "Image");
    expect(pngDimensions(buffer)).toEqual({ width: 120, height: 80 });
    expect(pixelAt(buffer, 60, 40)).toEqual([255, 0, 0, 255]);
  }, 20_000);

  test("waits for a srcdoc iframe to render its document", async () => {
    const buffer = await captureSingle(mediaStory, "SrcDocFrame");
    expect(pngDimensions(buffer)).toEqual({ width: 200, height: 100 });
    expect(pixelAt(buffer, 100, 50)).toEqual([0, 0, 255, 255]);
  }, 20_000);

  test("waits for an iframe that loads its document from the network", async () => {
    const buffer = await captureSingle(mediaStory, "SlowFrame");
    expect(pngDimensions(buffer)).toEqual({ width: 200, height: 100 });
    expect(pixelAt(buffer, 100, 50)).toEqual([255, 0, 255, 255]);
  }, 20_000);

  test("waits for the fonts and images of a framed document, which its load event does not", async () => {
    const page: Page = await browser.newPage();
    try {
      await page.setViewportSize({ width: 800, height: 600 });
      await renderStory(page, serverUrl, "fixtures/media--FrameWithResources", snapshotConfig());
      const inner = await page.evaluate(() => {
        const doc = document.querySelector("iframe").contentDocument;
        return {
          fonts: doc.fonts.status,
          loadedFaces: [...doc.fonts].filter((f: any) => f.status === "loaded").length,
          imagesComplete: [...doc.images].every((i: any) => i.complete && i.naturalWidth > 0),
        };
      });
      expect(inner).toEqual({ fonts: "loaded", loadedFaces: 1, imagesComplete: true });
      const buffer = await captureStoryOrPage(page, "fixtures/media--FrameWithResources");
      // The framed image sits below one 24px line of text; the pixel must be red.
      expect(pixelAt(buffer, 60, 100)).toEqual([255, 0, 0, 255]);
    } finally {
      await page.close();
    }
  }, 20_000);

  test("waits for a finite Web Animations API animation to finish", async () => {
    const buffer = await captureSingle(motionStory, "FadeIn");
    // Fully opaque green: not the transparent first frame, not a blend.
    expect(pixelAt(buffer, 100, 50)).toEqual([0, 255, 0, 255]);
  }, 20_000);

  test("pauses an animation that would never end at its first frame", async () => {
    const buffer = await captureSingle(motionStory, "Spinner");
    expect(pngDimensions(buffer)).toEqual({ width: 100, height: 100 });
    expect(pixelAt(buffer, 25, 50)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(buffer, 75, 50)).toEqual([0, 0, 255, 255]);
  }, 20_000);

  test("emulates prefers-reduced-motion: reduce", async () => {
    const buffer = await captureSingle(motionStory, "ReducedMotion");
    expect(pixelAt(buffer, 50, 30)).toEqual([0, 255, 0, 255]);
  }, 20_000);

  test("flags the document with data-storybun-snapshot", async () => {
    const buffer = await captureSingle(motionStory, "SnapshotFlag");
    expect(pixelAt(buffer, 50, 30)).toEqual([0, 255, 0, 255]);
  }, 20_000);

  test("fails a story that never settles, naming it and what it was waiting on", async () => {
    const { captures, failures } = await captureAll(
      browser,
      [{ ...asyncStory, exports: ["NeverSettles"] }],
      snapshotConfig({ settleTimeout: 1_000 }),
      serverUrl,
    );
    expect(captures).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.error.message).toMatch(
      /^fixtures\/async--NeverSettles: story did not settle within 1000ms: the DOM changed between two frames/,
    );
  }, 20_000);

  test("keeps the clock frozen for every page of a context, not only the first", async () => {
    const { captures, failures } = await captureAllWithBuffers(
      browser,
      [clockStory],
      snapshotConfig({ clock: FROZEN_AT }),
      serverUrl,
    );
    expect(failures).toEqual([]);
    expect(captures.map((c) => c.storyKey)).toEqual(["fixtures/clock--First", "fixtures/clock--Second"]);
    for (const c of captures) {
      expect(pngDimensions(c.buffer)).toEqual({ width: 100, height: 60 });
      expect(pixelAt(c.buffer, 50, 30)).toEqual([0, 255, 0, 255]);
    }
  }, 20_000);

  // Pages whose HTML the test writes itself, served through a route so that
  // `renderStory` drives them exactly as it drives a built story.
  async function renderHandBuilt(storyKey: string, html: string): Promise<Buffer> {
    const page: Page = await browser.newPage();
    try {
      await page.route(
        (url) => url.pathname === "/snapshot" && url.searchParams.get("story") === storyKey,
        (route) => route.fulfill({ contentType: "text/html", body: html }),
      );
      await page.setViewportSize({ width: 800, height: 600 });
      await renderStory(page, serverUrl, storyKey, snapshotConfig());
      return await captureStoryOrPage(page, storyKey);
    } finally {
      await page.close();
    }
  }

  test("waits for the marker when the ready flag fires before React has committed", async () => {
    const buffer = await renderHandBuilt(
      "race--Late",
      `<!doctype html><html data-storybun-snapshot><body><div id="root"></div><script>
        window.__STORYBUN_READY__ = true;
        setTimeout(() => {
          const marker = document.createElement("div");
          marker.setAttribute("data-storybun-story", "");
          marker.innerHTML = '<div style="width:200px;height:100px;background:#00ff00"></div>';
          document.getElementById("root").appendChild(marker);
        }, 300);
      </script></body></html>`,
    );
    expect(pngDimensions(buffer)).toEqual({ width: 200, height: 100 });
    expect(pixelAt(buffer, 100, 50)).toEqual([0, 255, 0, 255]);
  }, 20_000);

  test("accepts a function as window.__storybunPending", async () => {
    const buffer = await renderHandBuilt(
      "pending--Function",
      `<!doctype html><html data-storybun-snapshot><body><div id="root">
        <div data-storybun-story=""><div id="box" style="width:200px;height:100px;background:#ff0000"></div></div>
      </div><script>
        let inFlight = 1;
        window.__storybunPending = () => inFlight;
        window.__STORYBUN_READY__ = true;
        setTimeout(() => {
          document.getElementById("box").style.background = "#00ff00";
          inFlight = 0;
        }, 300);
      </script></body></html>`,
    );
    expect(pixelAt(buffer, 100, 50)).toEqual([0, 255, 0, 255]);
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
