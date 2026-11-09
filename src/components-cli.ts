import { collectComponents, searchComponents, type ComponentDoc } from "./components.ts";
import { loadConfig } from "./config.ts";
import { print } from "./print.ts";
import { scanStories } from "./scanner.ts";

export interface ComponentsOptions {
  /** Free-text search; unset lists every component as a one-line index. */
  query?: string;
  json: boolean;
  /** Every component in full instead of the index; with a query, every match. */
  full: boolean;
  /** Most matches shown in full when searching (default 5). */
  limit?: number;
}

/** One line of the index: enough to pick a component, small enough to list them all. */
export interface ComponentSummary {
  name: string;
  /** The import line other packages use, else the package's own alias, else the source file. */
  import: string;
  /** First sentence of the doc comment; null when it has none. */
  summary: string | null;
  deprecated?: string;
}

/**
 * `storybun components [query]`: the component catalogue.
 *
 * - no query: a one-line index of every component (name, import, summary);
 * - a query: the best `--limit` matches in full -- import lines, source,
 *   doc comment, variants and stories;
 * - `--full`: every component (or every match) in full.
 *
 * `--json` emits the same selection as JSON. The full catalogue of a large
 * project is megabytes, far more than a coding agent's context should take,
 * so nothing prints it unless asked for with `--full`.
 */
export async function runComponents(cwd: string, options: ComponentsOptions): Promise<number> {
  const config = await loadConfig(cwd);
  const { stories } = await scanStories(config, cwd);

  let result;
  try {
    result = await collectComponents(cwd, config, stories);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  for (const warning of result.warnings) console.error(`warning: ${warning}`);

  const query = options.query?.trim();
  let components = result.components;
  if (query) {
    components = searchComponents(components, query);
    const matches = components.length;
    if (!options.full) components = components.slice(0, options.limit ?? 5);
    if (matches > components.length) {
      console.error(`${components.length} of ${matches} matches; --limit <n> shows more.`);
    }
  }

  const detailed = Boolean(query) || options.full;

  if (options.json) {
    await print(JSON.stringify(detailed ? components : components.map(summarize), null, 2));
    return components.length > 0 ? 0 : 1;
  }

  if (components.length === 0) {
    console.error(query ? `No component matches ${JSON.stringify(query)}.` : "No component found in any story.");
    return 1;
  }

  if (detailed) {
    await print(components.map(formatComponent).join("\n\n"));
  } else {
    const width = Math.min(32, Math.max(...components.map((c) => c.name.length)));
    await print(
      components
        .map(summarize)
        .map((c) => {
          const summary = c.deprecated !== undefined ? `Deprecated. ${c.deprecated}` : c.summary;
          return `${c.name.padEnd(width)}  ${c.import}${summary ? `  — ${firstSentence(summary)}` : ""}`;
        })
        .join("\n"),
    );
    const undocumented = components.filter((c) => c.description === null).length;
    if (undocumented > 0) {
      console.error(`\n${undocumented} of ${components.length} components have no doc comment.`);
    }
    if (result.unlinked.length > 0) {
      console.error(
        `${result.unlinked.length} story file(s) demonstrate no component storybun could resolve; ` +
          "name the component with an `@component` tag in the doc comment above the file's first import.",
      );
    }
  }
  return 0;
}

export function summarize(c: ComponentDoc): ComponentSummary {
  const from = /from '([^']+)'/.exec(c.import ?? c.localImport ?? "")?.[1] ?? c.file;
  return {
    name: c.name,
    import: from,
    summary: c.description ? firstSentence(c.description) : null,
    ...(c.deprecated !== undefined ? { deprecated: c.deprecated } : {}),
  };
}

export function formatComponent(c: ComponentDoc): string {
  const lines: string[] = [c.name];
  if (c.deprecated !== undefined) lines.push(`  DEPRECATED${c.deprecated ? `: ${c.deprecated}` : ""}`);
  if (c.import) lines.push(`  ${c.import}`);
  if (c.localImport) lines.push(`  ${c.localImport}  (inside ${c.package})`);
  lines.push(`  source  ${c.file}:${c.line}`);
  lines.push("", c.description ? indent(c.description, 2) : "  (no description)");

  if (c.variants) {
    lines.push("");
    for (const axis of c.variants) {
      const values = axis.values.map((v) => (v.name === axis.default ? `${v.name}*` : v.name)).join(" | ");
      lines.push(`  ${axis.name}: ${values}`);
      if (axis.description) lines.push(indent(axis.description, 4));
      for (const v of axis.values) {
        if (v.description) lines.push(`    ${v.name} — ${v.description.replace(/\s*\n\s*/g, " ")}`);
      }
    }
  }

  for (const group of c.stories) {
    lines.push("", `  stories  ${group.file}`);
    for (const s of group.stories) {
      lines.push(`    ${s.key}${s.description ? `  — ${firstSentence(s.description)}` : ""}`);
    }
  }
  return lines.join("\n");
}

function indent(text: string, n: number): string {
  return text
    .split("\n")
    .map((l) => (l ? " ".repeat(n) + l : l))
    .join("\n");
}

function firstSentence(text: string): string {
  const flat = text.replace(/\s*\n\s*/g, " ").trim();
  const end = flat.search(/[.!?](\s|$)/);
  return end === -1 ? flat : flat.slice(0, end + 1);
}
