import { existsSync, readFileSync, realpathSync } from "fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "path";
import type TS from "typescript";
import { storyOutputPath } from "./snapshot/capture.ts";
import type { ResolvedConfig, StoryEntry } from "./types.ts";

/**
 * The component catalogue: every component a story demonstrates, with what a
 * developer (or a coding agent) needs to use it without reading the stories --
 * where it is declared, how to import it, what its doc comment says and which
 * variants it takes.
 *
 * Everything is read from source with the TypeScript parser, one file at a
 * time and without a type checker, so it needs neither a bundle nor a browser
 * and stays fast on a few hundred story files.
 */

export interface DocComment {
  description?: string;
  tags: { name: string; text: string }[];
}

export interface VariantValue {
  name: string;
  description?: string;
}

export interface VariantAxis {
  name: string;
  description?: string;
  default?: string;
  values: VariantValue[];
}

export interface ComponentStory {
  key: string;
  export: string;
  /** Story file, relative to the project root. */
  file: string;
  description?: string;
  /** Existing baseline images of this story, relative to the project root. */
  baselines: string[];
}

export interface ComponentDoc {
  name: string;
  /** Declaring file, relative to the project root. */
  file: string;
  /** 1-based line of the declaration. */
  line: number;
  /** Name of the package that declares it. */
  package: string;
  description?: string;
  /** Set when the doc comment has `@deprecated`; the tag text, or "" when it has none. */
  deprecated?: string;
  /** Import from outside the package, through its package.json `exports`. */
  import?: string;
  /** Import from inside the package, through a tsconfig `paths` alias. */
  localImport?: string;
  variants: VariantAxis[];
  stories: ComponentStory[];
}

export interface CatalogueResult {
  components: ComponentDoc[];
  /** Story files (relative) that demonstrate no component storybun could find. */
  unlinked: string[];
  warnings: string[];
}

type Ts = typeof TS;

/**
 * TypeScript is an optional peer: only this command needs it, and every
 * project with `.tsx` stories already has it installed. Resolve it from the
 * project first so the parser matches the one the project compiles with.
 */
async function loadTypeScript(cwd: string): Promise<Ts> {
  let mod: { default?: Ts } & Ts;
  try {
    mod = await import(Bun.resolveSync("typescript", cwd));
  } catch {
    try {
      mod = await import("typescript");
    } catch {
      throw new Error(
        "`storybun components` reads stories with the TypeScript parser. Install it: bun add -d typescript",
      );
    }
  }
  return mod.default ?? mod;
}

interface Declaration {
  file: string;
  name: string;
  /** The node whose leading comment documents it (the statement for a variable). */
  docNode: TS.Node;
  /** The node holding the component body, searched for the variants it uses. */
  body: TS.Node;
  sourceFile: TS.SourceFile;
}

const STORY_SUFFIX = /\.stories\.(tsx|ts|jsx|js)$/;

export class Catalogue {
  private readonly sources = new Map<string, TS.SourceFile | null>();
  private readonly packages = new Map<string, { name: string; dir: string; exports: unknown } | null>();
  private readonly aliases = new Map<string, { prefix: string; target: string }[]>();

  constructor(
    private readonly ts: Ts,
    private readonly cwd: string,
  ) {}

  static async create(cwd: string): Promise<Catalogue> {
    return new Catalogue(await loadTypeScript(cwd), cwd);
  }

  parse(file: string): TS.SourceFile | null {
    if (this.sources.has(file)) return this.sources.get(file)!;
    let sf: TS.SourceFile | null = null;
    try {
      const text = readFileSync(file, "utf8");
      const kind = /\.[jt]sx$/.test(file) ? this.ts.ScriptKind.TSX : this.ts.ScriptKind.TS;
      sf = this.ts.createSourceFile(file, text, this.ts.ScriptTarget.Latest, true, kind);
    } catch {
      sf = null;
    }
    this.sources.set(file, sf);
    return sf;
  }

  /** Resolve an import specifier the way Bun would, to a real file inside the project. */
  resolveImport(specifier: string, fromFile: string): string | undefined {
    try {
      const resolved = realpathSync(Bun.resolveSync(specifier, dirname(fromFile)));
      if (!this.isProjectFile(resolved)) return undefined;
      return resolved;
    } catch {
      return undefined;
    }
  }

  private isProjectFile(file: string): boolean {
    const rel = relative(this.cwd, file);
    if (rel.startsWith("..") || rel.startsWith(sep)) return false;
    return !rel.split(sep).includes("node_modules") && /\.(tsx|ts|jsx|js|mts|mjs)$/.test(file);
  }

  /**
   * Find where `name`, as exported by `file`, is declared, following
   * re-exports (`export { X } from`, `export *`) and local `export { X }`
   * lists through any number of barrels.
   */
  findExport(file: string, name: string, seen = new Set<string>()): Declaration | undefined {
    const key = `${file}#${name}`;
    if (seen.has(key)) return undefined;
    seen.add(key);

    const ts = this.ts;
    const sf = this.parse(file);
    if (!sf) return undefined;

    for (const stmt of sf.statements) {
      if (hasExportModifier(ts, stmt)) {
        const local = declarationIn(ts, stmt, name);
        if (local) return { file, name, sourceFile: sf, ...local };
      }
    }

    for (const stmt of sf.statements) {
      if (!ts.isExportDeclaration(stmt) || stmt.isTypeOnly) continue;
      const spec = stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
        ? stmt.moduleSpecifier.text
        : undefined;

      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          if (el.isTypeOnly || el.name.text !== name) continue;
          const localName = (el.propertyName ?? el.name).text;
          if (spec) {
            const target = this.resolveImport(spec, file);
            return target ? this.findExport(target, localName, seen) : undefined;
          }
          return this.findLocal(file, localName, seen);
        }
      } else if (!stmt.exportClause && spec) {
        const target = this.resolveImport(spec, file);
        const found = target ? this.findExport(target, name, seen) : undefined;
        if (found) return found;
      }
    }
    return undefined;
  }

  /** A binding declared or imported at the top level of `file`. */
  findLocal(file: string, name: string, seen = new Set<string>()): Declaration | undefined {
    const ts = this.ts;
    const sf = this.parse(file);
    if (!sf) return undefined;

    for (const stmt of sf.statements) {
      const local = declarationIn(ts, stmt, name);
      if (local) return { file, name, sourceFile: sf, ...local };
    }
    const imported = importsOf(ts, sf).get(name);
    if (imported && imported.imported !== "default") {
      const target = this.resolveImport(imported.specifier, file);
      if (target) return this.findExport(target, imported.imported, seen);
    }
    return undefined;
  }

  docOf(node: TS.Node, sf: TS.SourceFile): DocComment | undefined {
    return leadingDoc(this.ts, node, sf);
  }

  /** The cva/tailwind-variants config the component body refers to, if any. */
  variantsOf(decl: Declaration): VariantAxis[] {
    const ts = this.ts;
    const sf = decl.sourceFile;
    const configs = new Map<string, TS.ObjectLiteralExpression>();

    for (const stmt of sf.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer || !ts.isCallExpression(d.initializer)) continue;
        const config = d.initializer.arguments.find(
          (a): a is TS.ObjectLiteralExpression => ts.isObjectLiteralExpression(a) && !!property(ts, a, "variants"),
        );
        if (config) configs.set(d.name.text, config);
      }
    }
    if (configs.size === 0) return [];

    let used: TS.ObjectLiteralExpression | undefined;
    const visit = (node: TS.Node) => {
      if (used) return;
      if (ts.isIdentifier(node) && configs.has(node.text)) used = configs.get(node.text);
      else ts.forEachChild(node, visit);
    };
    visit(decl.body);
    if (!used) return [];

    const variants = property(ts, used, "variants");
    const defaults = property(ts, used, "defaultVariants");
    if (!variants || !ts.isObjectLiteralExpression(variants.initializer)) return [];

    const defaultValues = new Map<string, string>();
    if (defaults && ts.isObjectLiteralExpression(defaults.initializer)) {
      for (const p of defaults.initializer.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        const name = propertyName(ts, p.name);
        if (name) defaultValues.set(name, literalText(ts, p.initializer, sf));
      }
    }

    const axes: VariantAxis[] = [];
    for (const axis of variants.initializer.properties) {
      if (!ts.isPropertyAssignment(axis) || !ts.isObjectLiteralExpression(axis.initializer)) continue;
      const name = propertyName(ts, axis.name);
      if (!name) continue;
      const values: VariantValue[] = [];
      for (const value of axis.initializer.properties) {
        if (!ts.isPropertyAssignment(value)) continue;
        const valueName = propertyName(ts, value.name);
        if (!valueName) continue;
        values.push(withDescription({ name: valueName }, leadingDoc(ts, value, sf)?.description));
      }
      axes.push(
        withDescription(
          { name, ...(defaultValues.has(name) ? { default: defaultValues.get(name) } : {}), values },
          leadingDoc(ts, axis, sf)?.description,
        ),
      );
    }
    return axes;
  }

  private packageOf(file: string): { name: string; dir: string; exports: unknown } | null {
    let dir = dirname(file);
    while (true) {
      if (this.packages.has(dir)) return this.packages.get(dir)!;
      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) {
        let pkg: Record<string, unknown> = {};
        try {
          pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        } catch {}
        const info = {
          name: typeof pkg.name === "string" ? pkg.name : basename(dir),
          dir,
          exports: pkg.exports ?? (typeof pkg.module === "string" ? pkg.module : pkg.main),
        };
        this.packages.set(dir, info);
        return info;
      }
      const parent = dirname(dir);
      if (parent === dir || relative(this.cwd, parent).startsWith("..")) return null;
      dir = parent;
    }
  }

  packageName(file: string): string {
    return this.packageOf(file)?.name ?? basename(this.cwd);
  }

  /**
   * The specifier another package imports `name` from: the package.json
   * `exports` entry that is the declaring file or a barrel re-exporting it.
   * Several entries can qualify; the shortest wins, being the one a human
   * would write.
   */
  publicSpecifier(decl: Declaration): string | undefined {
    const pkg = this.packageOf(decl.file);
    if (!pkg || pkg.exports === undefined) return undefined;

    const candidates: string[] = [];
    for (const [key, target] of exportEntries(pkg.exports)) {
      const subpath = key === "." ? "" : key.slice(1);
      if (key.includes("*")) {
        const [tPrefix, tSuffix] = target.split("*") as [string, string];
        const abs = resolve(pkg.dir, tPrefix);
        const rel = relative(abs, decl.file);
        if (rel.startsWith("..") || !decl.file.endsWith(tSuffix)) continue;
        const matched = tSuffix ? rel.slice(0, rel.length - tSuffix.length) : rel;
        candidates.push(pkg.name + subpath.replace("*", matched.split(sep).join("/")));
        continue;
      }
      const abs = resolve(pkg.dir, target);
      if (!existsSync(abs)) continue;
      const real = realpathSync(abs);
      if (real === decl.file || this.findExport(real, decl.name)?.file === decl.file) {
        candidates.push(pkg.name + subpath);
      }
    }
    return candidates.sort((a, b) => a.length - b.length)[0];
  }

  /** The specifier the declaring package uses for it through a tsconfig `paths` alias. */
  localSpecifier(decl: Declaration): string | undefined {
    const pkg = this.packageOf(decl.file);
    const aliases = this.tsconfigAliases(pkg?.dir ?? this.cwd);
    for (const { prefix, target } of aliases) {
      const rel = relative(target, decl.file);
      if (rel.startsWith("..")) continue;
      let spec = prefix + rel.split(sep).join("/");
      spec = spec.slice(0, spec.length - extname(spec).length).replace(/\/index$/, "");
      return spec;
    }
    return undefined;
  }

  private tsconfigAliases(dir: string): { prefix: string; target: string }[] {
    if (this.aliases.has(dir)) return this.aliases.get(dir)!;
    const ts = this.ts;
    const result: { prefix: string; target: string }[] = [];

    let configPath: string | undefined = join(dir, "tsconfig.json");
    const visited = new Set<string>();
    let paths: Record<string, string[]> | undefined;
    let pathsBase: string | undefined;
    let baseUrl: string | undefined;
    while (configPath && existsSync(configPath) && !visited.has(configPath)) {
      visited.add(configPath);
      const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
      const options = config?.compilerOptions ?? {};
      if (!paths && options.paths) {
        paths = options.paths;
        pathsBase = dirname(configPath);
      }
      if (!baseUrl && typeof options.baseUrl === "string") baseUrl = resolve(dirname(configPath), options.baseUrl);
      const ext = typeof config?.extends === "string" ? config.extends : undefined;
      configPath = ext && ext.startsWith(".")
        ? resolve(dirname(configPath), ext.endsWith(".json") ? ext : `${ext}.json`)
        : undefined;
    }

    for (const [key, targets] of Object.entries(paths ?? {})) {
      const target = targets[0];
      if (!key.endsWith("/*") || !target?.endsWith("/*")) continue;
      result.push({
        prefix: key.slice(0, -1),
        target: resolve(baseUrl ?? pathsBase!, target.slice(0, -1)),
      });
    }
    this.aliases.set(dir, result);
    return result;
  }

  /** The components a story file demonstrates; see `collectComponents`. */
  storyFile(storyFile: string): {
    doc?: DocComment;
    components: { decl: Declaration; local: string }[];
    unknownTags: string[];
    exportDocs: Map<string, string | undefined>;
    /** Per story export, every identifier its render tree reaches in this file. */
    exportRenders: Map<string, Set<string>>;
  } {
    const ts = this.ts;
    const sf = this.parse(storyFile);
    if (!sf) return { components: [], unknownTags: [], exportDocs: new Map(), exportRenders: new Map() };

    const first = sf.statements[0];
    const doc = first && ts.isImportDeclaration(first) ? leadingDoc(ts, first, sf) : undefined;
    const tagged = (doc?.tags ?? [])
      .filter((t) => t.name === "component")
      .flatMap((t) => t.text.split(/[\s,]+/).filter(Boolean));

    const imports = importsOf(ts, sf);
    const jsx = jsxTagNames(ts, sf);

    const resolveName = (local: string): Declaration | undefined => {
      const imp = imports.get(local);
      if (!imp || imp.imported === "default") return undefined;
      const target = this.resolveImport(imp.specifier, storyFile);
      return target ? this.findExport(target, imp.imported) : undefined;
    };

    let components: { decl: Declaration; local: string }[] = [];
    const unknownTags: string[] = [];

    // The story file is named after what it demonstrates: `badge.stories.tsx` -> `badge.tsx`.
    const storyBase = basename(storyFile).replace(STORY_SUFFIX, "");

    if (tagged.length > 0) {
      for (const tag of tagged) {
        // `Name` (imported here, or exported by the same-named sibling module)
        // or `specifier#Name` for a component the file only reaches through a harness.
        const hash = tag.lastIndexOf("#");
        let decl: Declaration | undefined;
        if (hash > 0) {
          const target = this.resolveImport(tag.slice(0, hash), storyFile);
          decl = target ? this.findExport(target, tag.slice(hash + 1)) : undefined;
        } else {
          decl = resolveName(tag);
          if (!decl) {
            const sibling = this.resolveImport(`./${storyBase}`, storyFile);
            decl = sibling ? this.findExport(sibling, tag) : undefined;
          }
        }
        if (decl) components.push({ decl, local: imports.has(tag) ? tag : decl.name });
        else unknownTags.push(tag);
      }
    } else {
      const candidates = [...imports.keys()]
        .filter((local) => /^[A-Z]/.test(local))
        .map((local) => ({ local, spec: imports.get(local)!.specifier, decl: resolveName(local) }))
        .filter((c): c is { local: string; spec: string; decl: Declaration } => !!c.decl);

      // Any reference counts here, not only JSX: an overlay story often hands
      // the component to a factory (`overlayStory(ConfirmDialog, …)`).
      components = candidates.filter((c) => moduleBase(c.decl.file) === storyBase);

      // Otherwise, the sibling code it renders, minus story fixtures and harnesses.
      if (components.length === 0) {
        components = candidates
          .filter((c) => jsx.has(c.local) && c.spec.startsWith("."))
          .filter((c) => {
            const name = basename(c.decl.file);
            return !name.startsWith("_") && !/fixture|harness|\.stories\./i.test(name);
          });
      }
    }

    const exportDocs = new Map<string, string | undefined>();
    for (const stmt of sf.statements) {
      if (ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          const local = (el.propertyName ?? el.name).text;
          const decl = sf.statements.map((s) => declarationIn(ts, s, local)).find(Boolean);
          exportDocs.set(el.name.text, decl ? leadingDoc(ts, decl.docNode, sf)?.description : undefined);
        }
      } else if (hasExportModifier(ts, stmt)) {
        for (const name of declaredNames(ts, stmt)) {
          exportDocs.set(name, leadingDoc(ts, stmt, sf)?.description);
        }
      }
    }

    // What each export renders: identifiers in its body, following the file's
    // own top-level helpers (a shared `ThingStory`, a fixture builder) so a
    // story is credited to the components it shows rather than to every
    // component its file demonstrates.
    const locals = new Map<string, TS.Node>();
    for (const stmt of sf.statements) {
      for (const name of declaredNames(ts, stmt)) {
        const decl = declarationIn(ts, stmt, name);
        if (decl) locals.set(name, decl.body);
      }
    }
    const reach = (start: string): Set<string> => {
      const seen = new Set<string>();
      const queue = [start];
      while (queue.length > 0) {
        const name = queue.pop()!;
        const body = locals.get(name);
        if (!body) continue;
        const visit = (node: TS.Node) => {
          if (ts.isIdentifier(node) && !seen.has(node.text)) {
            seen.add(node.text);
            if (locals.has(node.text)) queue.push(node.text);
          }
          ts.forEachChild(node, visit);
        };
        visit(body);
      }
      return seen;
    };
    const exportRenders = new Map<string, Set<string>>();
    for (const stmt of sf.statements) {
      if (ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          exportRenders.set(el.name.text, reach((el.propertyName ?? el.name).text));
        }
      } else if (hasExportModifier(ts, stmt)) {
        for (const name of declaredNames(ts, stmt)) exportRenders.set(name, reach(name));
      }
    }

    const unique = new Map(components.map((c) => [`${c.decl.file}#${c.decl.name}`, c]));
    return { doc, components: [...unique.values()], unknownTags, exportDocs, exportRenders };
  }

  describe(decl: Declaration): Omit<ComponentDoc, "stories"> {
    const doc = leadingDoc(this.ts, decl.docNode, decl.sourceFile);
    const deprecated = doc?.tags.find((t) => t.name === "deprecated");
    const publicSpec = this.publicSpecifier(decl);
    const localSpec = this.localSpecifier(decl);
    const line = decl.sourceFile.getLineAndCharacterOfPosition(decl.docNode.getStart(decl.sourceFile)).line + 1;
    return {
      name: decl.name,
      file: relative(this.cwd, decl.file),
      line,
      package: this.packageName(decl.file),
      ...(doc?.description ? { description: doc.description } : {}),
      ...(deprecated ? { deprecated: deprecated.text } : {}),
      ...(publicSpec ? { import: `import { ${decl.name} } from '${publicSpec}'` } : {}),
      ...(localSpec ? { localImport: `import { ${decl.name} } from '${localSpec}'` } : {}),
      variants: this.variantsOf(decl),
    };
  }
}

/**
 * Build the catalogue from the scanned stories. A story file demonstrates:
 *
 * 1. the components named by `@component` tags in its file-level doc comment
 *    (the comment above its first import), when it has any;
 * 2. otherwise the components it renders whose module shares its name
 *    (`badge.stories.tsx` -> `./badge`);
 * 3. otherwise every component it renders from a relative import, except
 *    files that look like story fixtures or harnesses.
 */
export async function collectComponents(
  cwd: string,
  config: ResolvedConfig,
  stories: StoryEntry[],
  catalogue?: Catalogue,
): Promise<CatalogueResult> {
  const cat = catalogue ?? (await Catalogue.create(cwd));
  const byKey = new Map<string, ComponentDoc>();
  const unlinked: string[] = [];
  const warnings: string[] = [];

  const { outDir, viewports, modes } = config.snapshot;
  const modeNames = Object.keys(modes);
  const viewport = viewports[0]!;

  for (const story of stories) {
    const relFile = relative(cwd, story.filePath);
    const info = cat.storyFile(story.filePath);
    for (const tag of info.unknownTags) {
      warnings.push(
        `${relFile}: @component ${tag} is neither imported by this file nor exported by its same-named module; ` +
          "write it as `<import specifier>#<Name>`",
      );
    }
    if (info.components.length === 0) {
      unlinked.push(relFile);
      continue;
    }

    const storyDocs: ComponentStory[] = story.exports.map((exportName) => {
      const baselines = (modeNames.length > 0 ? modeNames : [undefined])
        .map((mode) => storyOutputPath(outDir, story.path, exportName, viewport, viewports.length === 1, mode))
        .filter((p) => existsSync(resolve(cwd, p)));
      const description = info.exportDocs.get(exportName);
      return {
        key: `${story.path}--${exportName}`,
        export: exportName,
        file: relFile,
        ...(description ? { description } : {}),
        baselines,
      };
    });

    for (const { decl, local } of info.components) {
      const key = `${decl.file}#${decl.name}`;
      let doc = byKey.get(key);
      if (!doc) {
        doc = { ...cat.describe(decl), stories: [] };
        byKey.set(key, doc);
      }
      // The stories that render it; all of the file's when none visibly does
      // (a story built by a factory from another module, say).
      const rendering = storyDocs.filter((s) => info.exportRenders.get(s.export)?.has(local));
      for (const s of rendering.length > 0 ? rendering : storyDocs) {
        if (!doc.stories.some((existing) => existing.key === s.key)) doc.stories.push(s);
      }
    }
  }

  const components = [...byKey.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file),
  );
  return { components, unlinked, warnings };
}

/**
 * Rank components against a free-text query. Every whitespace-separated term
 * is matched case-insensitively against the name, import paths, source path,
 * doc comment, variants and stories; components matching more terms rank
 * first, then by where they matched (the name counts most).
 */
export function searchComponents(components: ComponentDoc[], query: string): ComponentDoc[] {
  const q = query.trim().toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return components;

  const scored = components.map((c) => {
    const fields: [string, number][] = [
      [c.name.toLowerCase(), 10],
      [`${c.import ?? ""} ${c.localImport ?? ""} ${c.file}`.toLowerCase(), 2],
      [(c.description ?? "").toLowerCase(), 4],
      [
        c.variants
          .flatMap((a) => [a.name, a.description ?? "", ...a.values.flatMap((v) => [v.name, v.description ?? ""])])
          .join(" ")
          .toLowerCase(),
        3,
      ],
      [c.stories.flatMap((s) => [s.export, s.description ?? ""]).join(" ").toLowerCase(), 1],
    ];
    let score = 0;
    let matched = 0;
    for (const term of terms) {
      let hit = false;
      for (const [text, weight] of fields) {
        if (text.includes(term)) {
          score += weight;
          hit = true;
        }
      }
      if (hit) matched++;
    }
    const name = c.name.toLowerCase();
    if (name === q) score += 1000;
    else if (name.startsWith(q)) score += 100;
    return { c, score, matched };
  });

  return scored
    .filter((s) => s.matched > 0)
    .sort((a, b) => b.matched - a.matched || b.score - a.score || a.c.name.localeCompare(b.c.name))
    .map((s) => s.c);
}

// --- syntax helpers ---------------------------------------------------------

function hasExportModifier(ts: Ts, node: TS.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function declarationIn(
  ts: Ts,
  stmt: TS.Statement,
  name: string,
): { docNode: TS.Node; body: TS.Node } | undefined {
  if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name?.text === name) {
    return { docNode: stmt, body: stmt };
  }
  if (ts.isVariableStatement(stmt)) {
    for (const d of stmt.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === name) {
        return { docNode: stmt, body: d.initializer ?? d };
      }
    }
  }
  return undefined;
}

function declaredNames(ts: Ts, stmt: TS.Statement): string[] {
  if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name) return [stmt.name.text];
  if (ts.isVariableStatement(stmt)) {
    return stmt.declarationList.declarations.flatMap((d) => (ts.isIdentifier(d.name) ? [d.name.text] : []));
  }
  return [];
}

function importsOf(ts: Ts, sf: TS.SourceFile): Map<string, { specifier: string; imported: string }> {
  const out = new Map<string, { specifier: string; imported: string }>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const clause = stmt.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const specifier = stmt.moduleSpecifier.text;
    if (clause.name) out.set(clause.name.text, { specifier, imported: "default" });
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        if (el.isTypeOnly) continue;
        out.set(el.name.text, { specifier, imported: (el.propertyName ?? el.name).text });
      }
    }
  }
  return out;
}

/** Root identifiers of every JSX tag: `<Badge>` and `<Tabs.List>` give Badge and Tabs. */
function jsxTagNames(ts: Ts, sf: TS.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: TS.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      let tag: TS.Node = node.tagName;
      while (ts.isPropertyAccessExpression(tag)) tag = tag.expression;
      if (ts.isIdentifier(tag)) names.add(tag.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

function property(ts: Ts, obj: TS.ObjectLiteralExpression, name: string): TS.PropertyAssignment | undefined {
  return obj.properties.find(
    (p): p is TS.PropertyAssignment => ts.isPropertyAssignment(p) && propertyName(ts, p.name) === name,
  );
}

function propertyName(ts: Ts, name: TS.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function literalText(ts: Ts, node: TS.Expression, sf: TS.SourceFile): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return node.getText(sf);
}

/** `badge.tsx` and `badge/index.tsx` are both the `badge` module. */
function moduleBase(file: string): string {
  const name = basename(file).replace(/\.(tsx|ts|jsx|js|mts|mjs)$/, "");
  return name === "index" ? basename(dirname(file)) : name;
}

function withDescription<T extends object>(value: T, description: string | undefined): T & { description?: string } {
  return description ? { ...value, description } : value;
}

/**
 * The `/** ... *\/` comment directly above a node. TypeScript only attaches
 * JSDoc to declarations, not to object-literal keys like cva variant values,
 * so the comment is read from the source text for every node alike.
 */
function leadingDoc(ts: Ts, node: TS.Node, sf: TS.SourceFile): DocComment | undefined {
  const ranges = ts.getLeadingCommentRanges(sf.text, node.getFullStart()) ?? [];
  const last = [...ranges].reverse().find((r) => sf.text.startsWith("/**", r.pos));
  if (!last) return undefined;
  return parseDocComment(sf.text.slice(last.pos, last.end));
}

export function parseDocComment(raw: string): DocComment {
  const lines = raw
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\* ?/, "").trimEnd());

  const description: string[] = [];
  const tags: { name: string; text: string[] }[] = [];
  for (const line of lines) {
    const tag = /^@(\w+)\s*(.*)$/.exec(line.trim());
    if (tag) tags.push({ name: tag[1]!, text: tag[2] ? [tag[2]] : [] });
    else if (tags.length > 0) tags[tags.length - 1]!.text.push(line);
    else description.push(line);
  }
  const text = description.join("\n").trim();
  return {
    ...(text ? { description: text } : {}),
    tags: tags.map((t) => ({ name: t.name, text: t.text.join("\n").trim() })),
  };
}

/** Flatten package.json `exports` to [subpath, file] pairs, skipping type-only targets. */
function exportEntries(exports: unknown): [string, string][] {
  const target = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(target).find(Boolean);
    if (value && typeof value === "object") {
      const conditions = value as Record<string, unknown>;
      for (const c of ["bun", "import", "default", "module", "require"]) {
        if (c in conditions) {
          const t = target(conditions[c]);
          if (t) return t;
        }
      }
    }
    return undefined;
  };

  if (typeof exports === "string" || Array.isArray(exports)) {
    const t = target(exports);
    return t ? [[".", t]] : [];
  }
  if (!exports || typeof exports !== "object") return [];
  const map = exports as Record<string, unknown>;
  if (!Object.keys(map).some((k) => k.startsWith("."))) {
    const t = target(map);
    return t ? [[".", t]] : [];
  }
  return Object.entries(map).flatMap(([key, value]) => {
    const t = target(value);
    return t && /\.(tsx|ts|jsx|js|mts|mjs)$/.test(t.replace("*", "x.ts")) ? [[key, t] as [string, string]] : [];
  });
}
