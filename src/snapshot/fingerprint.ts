import { realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "path";
import type { BunPlugin } from "bun";
import type { ResolvedSnapshotConfig, SnapshotMode, StoryEntry } from "../types.ts";

/**
 * A capture's fingerprint is a hash of everything that can change its pixels:
 * the modules its page loads, the stylesheets every page links, and the
 * environment it is rendered in. A capture whose fingerprint equals the one
 * recorded with its baseline would render the same image again, so the run
 * leaves it out. Nothing here looks at a diff or at paths that "usually"
 * matter: what a story depends on is read from the bundle that was just
 * built, so a new import, a dependency bump or a moved file is covered
 * without anyone maintaining a rule for it.
 */

/** The part of Bun's build metafile the fingerprints are derived from. */
export interface BuildGraph {
  inputs: Record<string, { bytes: number; imports?: { path: string; kind: string; external?: boolean }[] }>;
  outputs: Record<
    string,
    {
      bytes: number;
      inputs?: Record<string, { bytesInOutput: number }>;
      imports?: { path: string; kind: string }[];
      entryPoint?: string;
    }
  >;
}

function sha(...parts: (string | Uint8Array)[]): string {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const part of parts) {
    hasher.update(part);
    // A separator, so ("ab", "c") and ("a", "bc") do not collide.
    hasher.update("\0");
  }
  return hasher.digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// What plugins load
// ---------------------------------------------------------------------------

/**
 * Hashes of module contents a plugin produced, keyed like the metafile keys
 * its inputs: `<namespace>:<path>`, or the path alone for the `file`
 * namespace. A module a plugin generates at build time (a rendered template,
 * a compiled asset) has no file to read afterwards, so its content is hashed
 * as the plugin hands it over.
 */
export type LoadedContents = Map<string, string>;

/**
 * Wraps each plugin so every `onLoad` result is hashed on its way to the
 * bundler. The plugin sees the same builder apart from that one method and
 * the bundler sees the same result.
 */
export function recordLoads(plugins: BunPlugin[], loaded: LoadedContents): BunPlugin[] {
  return plugins.map((plugin) => ({
    ...plugin,
    setup(build) {
      const record = (args: { path: string; namespace?: string }, result: unknown) => {
        const contents = (result as { contents?: unknown } | undefined | null)?.contents;
        if (typeof contents === "string" || contents instanceof Uint8Array) {
          const namespace = args.namespace && args.namespace !== "file" ? args.namespace : null;
          loaded.set(namespace ? `${namespace}:${args.path}` : resolve(args.path), sha(contents));
        }
        return result;
      };
      const proxy: typeof build = new Proxy(build, {
        get(target, prop) {
          if (prop === "onLoad") {
            return (constraints: unknown, callback: (args: any) => unknown) => {
              (target as any).onLoad(constraints, (args: any) => {
                const result = callback(args);
                return result instanceof Promise ? result.then((r) => record(args, r)) : record(args, result);
              });
              return proxy;
            };
          }
          const value = Reflect.get(target, prop);
          if (typeof value !== "function") return value;
          // Registration methods return the builder for chaining; hand back
          // the proxy, or a chained `.onLoad` would go unrecorded.
          return (...args: unknown[]) => {
            const result = value.apply(target, args);
            return result === target ? proxy : result;
          };
        },
      });
      return plugin.setup(proxy);
    },
  }));
}

// ---------------------------------------------------------------------------
// Which modules a story's page loads
// ---------------------------------------------------------------------------

/** The generated module every snapshot page starts from; see `entry.ts`. */
const ENTRY_MODULE = "_storybun_snapshot_entry.tsx";

/** A path as the bundler reports it: symlinks resolved. */
function realPath(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

/**
 * For each story file, the inputs that end up in the chunks its page loads:
 * the entry chunk, which the page's HTML names, the story's own chunk, and
 * every chunk reachable from either. The one import not followed is the
 * entry's dynamic import of a story chunk, which is how the generated entry
 * reaches every story; a page loads one of them. A lazy import anywhere else
 * is followed, since rendering may load it. `bytesInOutput > 0` leaves out
 * modules the bundler dropped, such as a barrel that only re-exports: adding
 * an export to it changes no page.
 */
export function storyPageInputs(graph: BuildGraph, storyFiles: string[]): Map<string, Set<string>> {
  const chunkOf = new Map<string, string>();
  let entryChunk: string | undefined;
  for (const [key, output] of Object.entries(graph.outputs)) {
    if (!output.entryPoint || !key.endsWith(".js")) continue;
    if (output.entryPoint.endsWith(ENTRY_MODULE)) entryChunk = key;
    else chunkOf.set(realPath(output.entryPoint), key);
  }
  const storyChunks = new Set<string>();
  for (const file of storyFiles) {
    const chunk = chunkOf.get(realPath(file));
    if (chunk) storyChunks.add(chunk);
  }

  const pages = new Map<string, Set<string>>();
  for (const file of storyFiles) {
    const inputs = new Set<string>();
    const start = chunkOf.get(realPath(file));
    const seen = new Set<string>();
    // The entry chunk is seeded and not only reached: a story chunk usually
    // imports it, but not when the bundler moved the shared modules out of
    // it (a top-level await in the Wrapper's graph does that).
    const stack = start ? [start, ...(entryChunk ? [entryChunk] : [])] : [];
    while (stack.length > 0) {
      const chunk = stack.pop()!;
      if (seen.has(chunk)) continue;
      seen.add(chunk);
      const output = graph.outputs[chunk]!;
      for (const [input, { bytesInOutput }] of Object.entries(output.inputs ?? {})) {
        if (bytesInOutput > 0) inputs.add(input);
      }
      for (const imported of output.imports ?? []) {
        const target = imported.path in graph.outputs ? imported.path : `./${imported.path.replace(/^\.\//, "")}`;
        if (!(target in graph.outputs)) continue;
        if (chunk === entryChunk && imported.kind === "dynamic-import" && storyChunks.has(target)) continue;
        stack.push(target);
      }
    }
    pages.set(file, inputs);
  }
  return pages;
}

/** `enum Name { ... }`, with or without `export`, `declare` or `const` in front. */
const ENUM_DECLARATION = /\benum\s+([A-Za-z_$][\w$]*)\s*\{([^}]*)\}/g;

function isProjectSource(input: string): boolean {
  return extname(input) in LOADERS && !input.includes("node_modules/");
}

/**
 * Every TypeScript enum a story could have had inlined: enum name -> hash of
 * its declaration(s).
 *
 * The bundler replaces `Tone.Calm` with the member's value in the importing
 * module and, when nothing else of the declaring module is used, drops that
 * module from the bundle and from the metafile. The importer's own source is
 * unchanged when the value changes, so the declaration has to be found from
 * the source side: in every module the metafile lists, and in the modules it
 * does not list that the listed ones import, followed through their own
 * imports (the barrels and re-exports an enum travels through).
 */
export async function collectEnums(graph: BuildGraph, modules: ModuleHashes): Promise<Map<string, string>> {
  const cwd = process.cwd();
  const queue: string[] = [];
  const seen = new Set<string>();
  for (const [input, { imports }] of Object.entries(graph.inputs)) {
    if (!isProjectSource(input)) continue;
    queue.push(input);
    // A dropped module is not a key of `inputs`, only an import target.
    for (const imported of imports ?? []) {
      if (!imported.external && !(imported.path in graph.inputs)) queue.push(imported.path);
    }
  }

  const bodies = new Map<string, string[]>();
  while (queue.length > 0) {
    const input = queue.pop()!;
    if (seen.has(input) || !isProjectSource(input)) continue;
    seen.add(input);
    const text = await modules.text(input);
    if (text === null) continue;
    for (const match of text.matchAll(ENUM_DECLARATION)) {
      const list = bodies.get(match[1]!) ?? [];
      list.push(match[2]!.replace(/\s+/g, " ").trim());
      bodies.set(match[1]!, list);
    }
    if (input in graph.inputs) continue;
    // Not in the metafile, so its imports are read from the source. One that
    // does not resolve is left alone: it cannot be followed.
    for (const imported of modules.scanImports(input, text)) {
      try {
        queue.push(relative(cwd, Bun.resolveSync(imported, dirname(resolve(input)))));
      } catch {}
    }
  }

  const enums = new Map<string, string>();
  for (const [name, list] of bodies) enums.set(name, sha(...list.sort()));
  return enums;
}

// ---------------------------------------------------------------------------
// Module contents
// ---------------------------------------------------------------------------

const LOADERS: Record<string, "ts" | "tsx" | "js" | "jsx"> = {
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx",
};

/**
 * Reads and hashes inputs, each once. Source the project owns is hashed
 * after transpiling, which drops types and comments: an interface gaining a
 * field, or a generated types file growing, renders nothing differently and
 * should not recapture every story that imports from it. Everything else
 * (dependencies, assets) is hashed as it is on disk.
 */
export class ModuleHashes {
  private readonly hashes = new Map<string, string>();
  private readonly mentioned = new Map<string, Set<string>>();
  private readonly texts = new Map<string, string | null>();
  private readonly transpilers = new Map<string, Bun.Transpiler>();
  /** Stands in for content that cannot be read, so it never equals a recorded hash. */
  private readonly unknown = `unknown:${crypto.randomUUID()}`;

  constructor(private readonly loaded: LoadedContents = new Map()) {}

  async text(input: string): Promise<string | null> {
    if (this.texts.has(input)) return this.texts.get(input)!;
    const file = Bun.file(resolve(input));
    const text = (await file.exists()) ? await file.text() : null;
    this.texts.set(input, text);
    return text;
  }

  /** The import and re-export specifiers of a source file, as written. */
  scanImports(input: string, text: string): string[] {
    try {
      return this.transpiler(LOADERS[extname(input)] ?? "ts").scanImports(text).map((i) => i.path);
    } catch {
      return [];
    }
  }

  /** Which of the given names a module's source mentions as a whole word. */
  async mentions(input: string, names: RegExp): Promise<Set<string>> {
    let found = this.mentioned.get(input);
    if (!found) {
      found = new Set<string>();
      const text = isProjectSource(input) ? await this.text(input) : null;
      for (const match of text?.matchAll(names) ?? []) found.add(match[0]);
      this.mentioned.set(input, found);
    }
    return found;
  }

  async hash(input: string): Promise<string> {
    const known = this.hashes.get(input);
    if (known !== undefined) return known;

    let hash: string;
    const recorded = this.loaded.get(input) ?? this.loaded.get(resolve(input));
    if (recorded !== undefined) {
      hash = recorded;
    } else {
      const loader = input.includes("node_modules/") ? undefined : LOADERS[extname(input)];
      if (loader) {
        const text = await this.text(input);
        hash = text === null ? this.unknown : sha(this.transpile(loader, text));
      } else {
        const file = Bun.file(resolve(input));
        hash = (await file.exists()) ? sha(new Uint8Array(await file.arrayBuffer())) : this.unknown;
      }
    }
    this.hashes.set(input, hash);
    return hash;
  }

  private transpiler(loader: "ts" | "tsx" | "js" | "jsx"): Bun.Transpiler {
    let transpiler = this.transpilers.get(loader);
    if (!transpiler) {
      transpiler = new Bun.Transpiler({ loader });
      this.transpilers.set(loader, transpiler);
    }
    return transpiler;
  }

  private transpile(loader: "ts" | "tsx" | "js" | "jsx", text: string): string {
    try {
      return this.transpiler(loader).transformSync(text);
    } catch {
      // The bundle built, so this is the standalone transpiler tripping over
      // something the bundler accepts. The raw text is the safe stand-in.
      return text;
    }
  }
}

// ---------------------------------------------------------------------------
// Stylesheets
// ---------------------------------------------------------------------------

const CSS_REFERENCE = /@(?:import|plugin|config|reference)\s+(?:url\(\s*)?["']([^"']+)["']|url\(\s*["']?([^"')]+)["']?\s*\)/g;
const CSS_BANNER = /\/\*![\s\S]*?\*\//g;

/**
 * The files a stylesheet reference stands for. A relative path is that file.
 * A package is its resolved entry and its `package.json`: a stylesheet-only
 * package exposes its sheet under a `style` condition the module resolver
 * does not follow, and the manifest, which carries the version, changes
 * whenever the package does.
 */
function resolveReference(specifier: string, fromDir: string): string[] {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(specifier)) return [];
  const found: string[] = [];
  const attempt = (candidate: string) => {
    try {
      found.push(Bun.resolveSync(candidate, fromDir));
      return true;
    } catch {
      return false;
    }
  };
  if (specifier.startsWith(".") || isAbsolute(specifier)) {
    if (!attempt(specifier)) found.push(isAbsolute(specifier) ? specifier : join(fromDir, specifier));
    return found;
  }
  const packageName = specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
  const asPackage = attempt(`${packageName}/package.json`);
  attempt(specifier);
  // `@import "partial.css"` may also mean the file next to this one.
  if (!asPackage && !attempt(`./${specifier}`)) found.push(join(fromDir, specifier));
  return found;
}

/**
 * One hash for the stylesheets every page links.
 *
 * The generated sheet itself is not hashed. A utility-class compiler emits a
 * rule per class name it finds in the sources, so the sheet changes whenever
 * any component gains a class, and the new rule only matches elements that
 * carry that class: those sit in the modules that changed, whose stories are
 * recaptured anyway. What can restyle an untouched story is the stylesheet
 * *source*: the entry stylesheets, everything they `@import`, `@plugin` or
 * `@config`, and the files their `url()`s point at. Those are hashed, along
 * with the `/*! ... *\/` banners of the generated sheets, which carry the
 * compiler's version.
 */
export async function stylesheetHash(graph: BuildGraph, outputDir: string): Promise<string> {
  const parts: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [];

  for (const [key, output] of Object.entries(graph.outputs)) {
    if (!key.endsWith(".css")) continue;
    for (const input of Object.keys(output.inputs ?? {})) queue.push(resolve(input));
    const built = Bun.file(join(outputDir, key));
    if (await built.exists()) {
      for (const banner of new Set((await built.text()).match(CSS_BANNER) ?? [])) parts.push(`banner:${banner}`);
    }
  }

  while (queue.length > 0) {
    const path = queue.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const file = Bun.file(path);
    if (!(await file.exists())) continue;
    const bytes = new Uint8Array(await file.arrayBuffer());
    parts.push(`${relative(process.cwd(), path)}:${sha(bytes)}`);
    if (extname(path) !== ".css") continue;
    for (const match of new TextDecoder().decode(bytes).matchAll(CSS_REFERENCE)) {
      queue.push(...resolveReference((match[1] ?? match[2])!, dirname(path)));
    }
  }

  return sha(...parts.sort());
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** A hash of this tool's own source: a new version may capture differently. */
export async function toolHash(): Promise<string> {
  const root = join(import.meta.dir, "..");
  const names = (await readdir(root, { recursive: true }))
    .filter((name) => /\.(ts|tsx|css)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.includes("__fixtures__"))
    .sort();
  const parts: string[] = [];
  for (const name of names) {
    parts.push(name, sha(new Uint8Array(await Bun.file(join(root, name)).arrayBuffer())));
  }
  return sha(...parts);
}

export interface FingerprintInput {
  graph: BuildGraph;
  /** Directory the bundle was written to, for the generated stylesheets. */
  outputDir: string;
  loaded: LoadedContents;
  stories: StoryEntry[];
  config: ResolvedSnapshotConfig;
  /** `browser.version()`: a browser update rasterises differently. */
  browserVersion: string;
}

/**
 * Fingerprints per story file: one hash covering the story's page and the
 * shared environment. `captureFingerprint` adds the viewport and the mode.
 */
export async function fingerprintStories(input: FingerprintInput): Promise<Map<string, string>> {
  const { graph, config } = input;
  const modules = new ModuleHashes(input.loaded);
  const storyFiles = input.stories.map((s) => s.filePath);
  const pages = storyPageInputs(graph, storyFiles);

  const environment = sha(
    await toolHash(),
    Bun.version,
    input.browserVersion,
    await stylesheetHash(graph, input.outputDir),
    JSON.stringify([config.clock, config.timezoneId, config.locale, config.environment]),
  );

  // A page's fingerprint includes every enum one of its modules names: the
  // member values are inlined into those modules by the bundler.
  const enums = await collectEnums(graph, modules);
  const enumNames =
    enums.size > 0
      ? new RegExp(`(?<![\\w$])(?:${[...enums.keys()].map((n) => n.replace(/\$/g, "\\$")).join("|")})(?![\\w$])`, "g")
      : null;

  const cwd = process.cwd();
  const fingerprints = new Map<string, string>();
  for (const file of storyFiles) {
    const page = pages.get(file)!;
    if (page.size === 0) {
      // The story has no chunk in the bundle: nothing is known about what it
      // renders, so it gets a fingerprint no recorded one can equal.
      fingerprints.set(file, sha(crypto.randomUUID()));
      continue;
    }
    const parts: string[] = [];
    const named = new Set<string>();
    for (const module of page) {
      if (enumNames) for (const name of await modules.mentions(module, enumNames)) named.add(name);
      // The generated entry lists every story, so it changes whenever one is
      // added; what it does is this tool's own code, covered by `toolHash`.
      if (module.endsWith(ENTRY_MODULE)) continue;
      // Ids must not depend on where the project is checked out.
      parts.push(`${module.replaceAll(`${cwd}/`, "")}=${await modules.hash(module)}`);
    }
    for (const name of named) parts.push(`enum ${name}=${enums.get(name)}`);
    fingerprints.set(file, sha(environment, ...parts.sort()));
  }
  return fingerprints;
}

export function captureFingerprint(
  storyFingerprint: string,
  viewport: { width: number; height: number },
  mode: SnapshotMode | undefined,
): string {
  return sha(storyFingerprint, `${viewport.width}x${viewport.height}`, JSON.stringify(mode ?? null));
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export const MANIFEST_FILE = "manifest.json";
const MANIFEST_VERSION = 1;

/** Baseline filename -> fingerprint of the capture the baseline was last checked against. */
export type Manifest = Record<string, string>;

/** The recorded fingerprints, or an empty manifest when there is none yet or it cannot be read. */
export async function readManifest(outDir: string): Promise<Manifest> {
  try {
    const parsed = (await Bun.file(join(outDir, MANIFEST_FILE)).json()) as {
      version?: number;
      fingerprints?: Manifest;
    };
    if (parsed.version !== MANIFEST_VERSION || typeof parsed.fingerprints !== "object") return {};
    return parsed.fingerprints ?? {};
  } catch {
    return {};
  }
}

export async function writeManifest(outDir: string, fingerprints: Manifest): Promise<void> {
  const sorted: Manifest = {};
  for (const key of Object.keys(fingerprints).sort()) sorted[key] = fingerprints[key]!;
  await Bun.write(
    join(outDir, MANIFEST_FILE),
    `${JSON.stringify({ version: MANIFEST_VERSION, fingerprints: sorted }, null, 1)}\n`,
  );
}
