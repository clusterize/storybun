import { collectComponents, searchComponents, type ComponentDoc } from "./components.ts";
import { loadConfig } from "./config.ts";
import { scanStories } from "./scanner.ts";

export interface ComponentsOptions {
  /** Free-text search; unset lists every component. */
  query?: string;
  json: boolean;
  /** Most matches to print in full when searching (default 5). */
  limit?: number;
}

/**
 * `storybun components [query]`: the component catalogue. Without a query it
 * prints one line per component; with one, the best matches in full -- the
 * import line, source location, doc comment, variants and stories -- so a
 * coding agent can pick and import a component without opening its stories.
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
    if (!options.json) components = components.slice(0, options.limit ?? 5);
  }

  if (options.json) {
    console.log(JSON.stringify(components, null, 2));
    return components.length > 0 ? 0 : 1;
  }

  if (components.length === 0) {
    console.error(query ? `No component matches ${JSON.stringify(query)}.` : "No component found in any story.");
    return 1;
  }

  if (query) {
    console.log(components.map(formatComponent).join("\n\n"));
  } else {
    const width = Math.min(32, Math.max(...components.map((c) => c.name.length)));
    for (const c of components) {
      const from = /from '([^']+)'/.exec(c.import ?? c.localImport ?? "")?.[1] ?? c.file;
      const summary = firstSentence(c.deprecated !== undefined ? `Deprecated. ${c.deprecated}` : c.description);
      console.log(`${c.name.padEnd(width)}  ${from}${summary ? `  — ${summary}` : ""}`);
    }
    if (result.unlinked.length > 0) {
      console.error(
        `\n${result.unlinked.length} story file(s) demonstrate no component storybun could resolve; ` +
          "name the component with an `@component` tag in the doc comment above the file's first import.",
      );
    }
  }
  return 0;
}

export function formatComponent(c: ComponentDoc): string {
  const lines: string[] = [c.name];
  if (c.deprecated !== undefined) lines.push(`  DEPRECATED${c.deprecated ? `: ${c.deprecated}` : ""}`);
  if (c.import) lines.push(`  ${c.import}`);
  if (c.localImport) lines.push(`  ${c.localImport}  (inside ${c.package})`);
  lines.push(`  source  ${c.file}:${c.line}`);
  if (c.description) lines.push("", indent(c.description, 2));

  if (c.variants.length > 0) {
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

  if (c.stories.length > 0) {
    lines.push("", "  stories");
    for (const s of c.stories) {
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

function firstSentence(text: string | undefined): string {
  if (!text) return "";
  const flat = text.replace(/\s*\n\s*/g, " ").trim();
  const end = flat.search(/[.!?](\s|$)/);
  return end === -1 ? flat : flat.slice(0, end + 1);
}
