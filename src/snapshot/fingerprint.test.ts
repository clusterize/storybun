import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "path";
import type { BunPlugin } from "bun";
import { buildSnapshotEntry } from "./entry.ts";
import {
  captureFingerprint,
  fingerprintStories,
  readManifest,
  storyPageInputs,
  writeManifest,
  type BuildGraph,
} from "./fingerprint.ts";
import type { PackageInfo, ResolvedConfig, StoryEntry } from "../types.ts";

const repoRoot = join(import.meta.dir, "..", "..");

/**
 * A small project on disk: two stories that share nothing but a barrel, an
 * enum reached through that barrel, and a stylesheet with a partial. Each
 * test edits one file and asks which stories' fingerprints moved.
 */
const PROJECT: Record<string, string> = {
  "ui/button.tsx": `import type { Size } from "./types";
export const Button = ({ size }: { size?: Size }) => <button>{size ?? "md"}</button>;
`,
  "ui/badge.tsx": `export const Badge = () => <span>badge</span>;
`,
  "ui/types.ts": `export type Size = "sm" | "md";
`,
  "ui/tone.ts": `export enum Tone { Calm = "calm", Loud = "loud" }
`,
  "ui/index.ts": `export * from "./button";
export * from "./badge";
export * from "./tone";
`,
  "package.json": `{ "name": "fixture", "sideEffects": false }
`,
  "styles.css": `@import "./partial.css";
.frame { padding: 4px; }
`,
  "partial.css": `.partial { color: red; }
`,
  "button.stories.tsx": `import { Button, Tone } from "./ui";
import "./styles.css";
export const Primary = () => <div data-tone={Tone.Calm}><Button /></div>;
`,
  "badge.stories.tsx": `import { Badge } from "./ui";
import "./styles.css";
export const Plain = () => <Badge />;
`,
};

let dir: string;

async function write(file: string, content: string): Promise<void> {
  await mkdir(dirname(join(dir, file)), { recursive: true });
  await Bun.write(join(dir, file), content);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "storybun-fingerprint-"));
  for (const [file, content] of Object.entries(PROJECT)) await write(file, content);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Options {
  storyFiles?: string[];
  plugins?: BunPlugin[];
  environment?: string;
  browserVersion?: string;
}

/** Builds the project as a snapshot run does and returns `story file -> fingerprint`. */
async function fingerprints(options: Options = {}): Promise<Record<string, string>> {
  const files = options.storyFiles ?? ["button.stories.tsx", "badge.stories.tsx"];
  const stories: StoryEntry[] = files.map((file) => ({
    path: file.replace(".stories.tsx", ""),
    filePath: join(dir, file),
    exports: ["Story"],
    packageName: "fixture",
  }));
  const config: ResolvedConfig = {
    stories: [],
    ignore: [],
    port: 0,
    plugins: options.plugins ?? [],
    components: {},
    snapshot: {
      outDir: "__snapshots__",
      threshold: 0.1,
      maxDiffPixels: 0,
      minColors: 2,
      minColorsIgnore: [],
      viewports: [{ width: 800, height: 600 }],
      settleTimeout: 2_000,
      markerTimeout: 500,
      concurrency: 1,
      codeowners: [],
      clock: null,
      timezoneId: "UTC",
      locale: "en-US",
      modes: {},
      environment: options.environment ?? "",
      report: { component: null },
    },
  };
  const packages = new Map<string, PackageInfo>([
    ["fixture", { name: "fixture", dir, config: { plugins: [], components: {} } }],
  ]);
  const build = await buildSnapshotEntry(stories, packages, config, repoRoot);
  const result = await fingerprintStories({
    graph: build.graph,
    outputDir: build.buildDir,
    loaded: build.loaded,
    stories,
    config: config.snapshot,
    browserVersion: options.browserVersion ?? "1.0",
  });
  return Object.fromEntries(files.map((file) => [file, result.get(join(dir, file))!]));
}

/** The story files whose fingerprint differs between two runs. */
function changed(before: Record<string, string>, after: Record<string, string>): string[] {
  return Object.keys(before)
    .filter((file) => before[file] !== after[file])
    .sort();
}

describe("fingerprintStories", () => {
  test("building the same sources twice gives the same fingerprints", async () => {
    expect(await fingerprints()).toEqual(await fingerprints());
  });

  test("editing a component moves only the stories whose page loads it", async () => {
    const before = await fingerprints();
    await write("ui/button.tsx", PROJECT["ui/button.tsx"]!.replace(`"md"`, `"lg"`));
    expect(changed(before, await fingerprints())).toEqual(["button.stories.tsx"]);
  });

  test("a type, a comment or whitespace is not a change", async () => {
    const before = await fingerprints();
    await write("ui/types.ts", `export type Size = "sm" | "md" | "lg";\n`);
    await write(
      "ui/button.tsx",
      `// A note.\n${PROJECT["ui/button.tsx"]!.replace("{ size?: Size }", "{\n  size?: Size;\n  wide?: boolean\n}")}`,
    );
    expect(changed(before, await fingerprints())).toEqual([]);
  });

  test("an export added to a barrel moves no story", async () => {
    const before = await fingerprints();
    await write("ui/card.tsx", `export const Card = () => <div>card</div>;\n`);
    await write("ui/index.ts", `${PROJECT["ui/index.ts"]}export * from "./card";\n`);
    expect(changed(before, await fingerprints())).toEqual([]);
  });

  test("a story file added next to the others moves none of them", async () => {
    const before = await fingerprints();
    await write("extra.stories.tsx", `import { Badge, Button } from "./ui";\nexport const Both = () => <><Badge /><Button /></>;\n`);
    const after = await fingerprints({ storyFiles: ["button.stories.tsx", "badge.stories.tsx", "extra.stories.tsx"] });
    expect(changed(before, after)).toEqual([]);
  });

  test("an enum member's value moves the story it is inlined into", async () => {
    // The bundler replaces `Tone.Calm` with its value and drops the module
    // that declares it, so nothing in the story's chunk names that file.
    const before = await fingerprints();
    await write("ui/tone.ts", `export enum Tone { Calm = "quiet", Loud = "loud" }\n`);
    expect(changed(before, await fingerprints())).toEqual(["button.stories.tsx"]);
  });

  test("an enum no story names moves none", async () => {
    await write("ui/tone.ts", `${PROJECT["ui/tone.ts"]}export enum Volume { Low = 1 }\n`);
    const before = await fingerprints();
    await write("ui/tone.ts", `${PROJECT["ui/tone.ts"]}export enum Volume { Low = 2 }\n`);
    expect(changed(before, await fingerprints())).toEqual([]);
  });

  test("a stylesheet, or one it imports, moves every story", async () => {
    const before = await fingerprints();
    await write("partial.css", `.partial { color: blue; }\n`);
    const afterPartial = await fingerprints();
    expect(changed(before, afterPartial)).toEqual(["badge.stories.tsx", "button.stories.tsx"]);

    await write("styles.css", PROJECT["styles.css"]!.replace("4px", "8px"));
    expect(changed(afterPartial, await fingerprints())).toEqual(["badge.stories.tsx", "button.stories.tsx"]);
  });

  test("a module a plugin generates is fingerprinted by what the plugin returned", async () => {
    let greeting = "hello";
    const plugin: BunPlugin = {
      name: "generated",
      setup(build) {
        build.onResolve({ filter: /^generated:/ }, (args) => ({ path: args.path.slice(10), namespace: "generated" }));
        build.onLoad({ filter: /.*/, namespace: "generated" }, () => ({
          contents: `export default ${JSON.stringify(greeting)};`,
          loader: "js",
        }));
      },
    };
    await write(
      "badge.stories.tsx",
      `import text from "generated:greeting";\nexport const Plain = () => <span>{text}</span>;\n`,
    );

    const before = await fingerprints({ plugins: [plugin] });
    expect(await fingerprints({ plugins: [plugin] })).toEqual(before);

    greeting = "goodbye";
    expect(changed(before, await fingerprints({ plugins: [plugin] }))).toEqual(["badge.stories.tsx"]);
  });

  test("the environment and the browser version move every story", async () => {
    const before = await fingerprints();
    const all = ["badge.stories.tsx", "button.stories.tsx"];
    expect(changed(before, await fingerprints({ environment: "image:2" }))).toEqual(all);
    expect(changed(before, await fingerprints({ browserVersion: "2.0" }))).toEqual(all);
  });
});

describe("storyPageInputs", () => {
  const graph: BuildGraph = {
    inputs: {},
    outputs: {
      "./entry.js": {
        bytes: 1,
        entryPoint: "entry.tsx",
        inputs: { "entry.tsx": { bytesInOutput: 9 }, "wrapper.tsx": { bytesInOutput: 5 } },
        imports: [
          { path: "./a.js", kind: "dynamic-import" },
          { path: "./b.js", kind: "dynamic-import" },
        ],
      },
      "./a.js": {
        bytes: 1,
        entryPoint: "a.stories.tsx",
        inputs: { "a.stories.tsx": { bytesInOutput: 3 }, "barrel.ts": { bytesInOutput: 0 } },
        imports: [
          { path: "./entry.js", kind: "import-statement" },
          { path: "./lazy.js", kind: "dynamic-import" },
        ],
      },
      "./b.js": {
        bytes: 1,
        entryPoint: "b.stories.tsx",
        inputs: { "b.stories.tsx": { bytesInOutput: 3 } },
        imports: [
          { path: "./entry.js", kind: "import-statement" },
          { path: "./a.js", kind: "import-statement" },
        ],
      },
      "./lazy.js": { bytes: 1, entryPoint: "lazy.tsx", inputs: { "lazy.tsx": { bytesInOutput: 2 } } },
    },
  };

  test("a page is its story's chunk plus what that reaches, never the other stories the entry lists", () => {
    const pages = storyPageInputs(graph, ["a.stories.tsx", "b.stories.tsx"]);
    // The lazily imported chunk counts: rendering may load it. The barrel
    // with nothing in the output does not.
    expect([...pages.get("a.stories.tsx")!].sort()).toEqual(["a.stories.tsx", "entry.tsx", "lazy.tsx", "wrapper.tsx"]);
  });

  test("a story that imports from another story file loads that story's chunk too", () => {
    const pages = storyPageInputs(graph, ["a.stories.tsx", "b.stories.tsx"]);
    expect([...pages.get("b.stories.tsx")!].sort()).toEqual([
      "a.stories.tsx",
      "b.stories.tsx",
      "entry.tsx",
      "lazy.tsx",
      "wrapper.tsx",
    ]);
  });
});

describe("captureFingerprint", () => {
  test("differs by viewport and by mode", () => {
    const base = captureFingerprint("story", { width: 800, height: 600 }, { colorScheme: "light" });
    expect(captureFingerprint("story", { width: 800, height: 600 }, { colorScheme: "light" })).toBe(base);
    expect(captureFingerprint("story", { width: 801, height: 600 }, { colorScheme: "light" })).not.toBe(base);
    expect(captureFingerprint("story", { width: 800, height: 600 }, { colorScheme: "dark" })).not.toBe(base);
    expect(captureFingerprint("story", { width: 800, height: 600 }, undefined)).not.toBe(base);
  });
});

describe("manifest", () => {
  test("reads back what was written", async () => {
    await writeManifest(dir, { "b.png": "2", "a.png": "1" });
    expect(await readManifest(dir)).toEqual({ "a.png": "1", "b.png": "2" });
  });

  test("a missing or unreadable manifest is an empty one, so every story is captured", async () => {
    expect(await readManifest(dir)).toEqual({});
    await Bun.write(join(dir, "manifest.json"), "{ not json");
    expect(await readManifest(dir)).toEqual({});
    await Bun.write(join(dir, "manifest.json"), JSON.stringify({ version: 99, fingerprints: { "a.png": "1" } }));
    expect(await readManifest(dir)).toEqual({});
  });
});
