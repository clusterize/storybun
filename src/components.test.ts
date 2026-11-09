import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { collectComponents, parseDocComment, searchComponents, type ComponentDoc } from "./components.ts";
import { formatComponent, summarize } from "./components-cli.ts";
import { loadConfig } from "./config.ts";
import { scanStories } from "./scanner.ts";

// A two-package workspace: a design-system package with an `exports` map and
// a barrel, and an app that imports it by name and aliases its own `src`.
const files: Record<string, string> = {
  "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
  "storybun.config.ts": "export default { snapshot: { modes: { light: {}, dark: {} } } }",
  "packages/kit/package.json": JSON.stringify({
    name: "@acme/kit",
    exports: {
      "./ui": { types: "./types/ui.d.ts", default: "./src/ui/index.ts" },
      "./frame": "./src/frame.tsx",
    },
  }),
  "packages/kit/tsconfig.json": JSON.stringify({
    compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } },
  }),
  "packages/kit/src/ui/index.ts": `export * from './badge'\nexport { Tag as Label } from './tag'\n`,
  "packages/kit/src/ui/badge.tsx": `
import { cva } from 'class-variance-authority'

const badgeVariants = cva('badge', {
  variants: {
    /** How loud the badge is. */
    tone: {
      /** Neutral facts: counts, labels. */
      plain: 'a',
      /** Something went wrong and needs a look. */
      danger: 'b',
    },
    size: { sm: 'c', md: 'd' },
  },
  defaultVariants: { tone: 'plain', size: 'md' },
})

/**
 * A short status label.
 *
 * Use it inline next to the thing it describes.
 */
function Badge({ tone, size }: { tone?: 'plain' | 'danger'; size?: 'sm' | 'md' }) {
  return <span className={badgeVariants({ tone, size })} />
}

export { Badge, badgeVariants }
`,
  "packages/kit/src/ui/badge.stories.tsx": `
import { Badge } from './badge'
import { Frame } from '../frame'

/** The default tone. */
const DefaultStory = () => <Frame><Badge /></Frame>

export const BadgeDanger = () => <Badge tone="danger" />

export { DefaultStory as Badge }
`,
  "packages/kit/src/ui/tag.tsx": `
/** @deprecated Use Badge. */
export const Tag = () => <span />
`,
  "packages/kit/src/frame.tsx": "export const Frame = ({ children }: { children?: unknown }) => <div>{children as never}</div>\n",
  "packages/app/package.json": JSON.stringify({ name: "@acme/app", dependencies: { "@acme/kit": "workspace:*" } }),
  "packages/app/tsconfig.json": JSON.stringify({ extends: "./tsconfig.base.json" }),
  "packages/app/tsconfig.base.json": JSON.stringify({
    compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } },
  }),
  // Two components in one file; each story is credited to the one it renders.
  "packages/app/src/job/job-parts.tsx": `
/** The job's title row. */
export const JobHeader = () => <h1 />
export const JobLog = () => <pre />
`,
  "packages/app/src/job/job-detail.stories.tsx": `
import { JobHeader, JobLog } from './job-parts'
import { seedJob } from './_story-fixtures'
import { Badge } from '@acme/kit/ui'

const Shell = ({ children }: { children?: unknown }) => <div>{children as never}</div>

const HeaderStory = () => <Shell><JobHeader /><Badge /></Shell>
/** The log after a retry from the confirm dialog. */
const LogStory = () => <JobLog />

export { HeaderStory as JobDetailHeader, LogStory as JobDetailLog }
`,
  "packages/app/src/job/_story-fixtures.tsx": "export const seedJob = 1\nexport const Harness = () => <div />\n",
  // Reaches its component only through a harness, so it names it.
  "packages/app/src/job/job-board.stories.tsx": `
/** @component JobBoard */
import { Harness } from './_story-fixtures'

export const JobBoard = () => <Harness />
`,
  "packages/app/src/job/job-board.tsx": "export function JobBoard() { return <div /> }\n",
  "packages/app/src/job/orphan.stories.tsx": `
/** @component Missing */
import { Harness } from './_story-fixtures'

export const Orphan = () => <Harness />
`,
};

let cwd: string;
let components: ComponentDoc[];
let unlinked: string[];
let warnings: string[];

beforeAll(async () => {
  cwd = realpathSync(await mkdtemp(join(tmpdir(), "storybun-components-")));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), content);
  }
  // What a workspace install leaves behind: the package linked by name.
  await mkdir(join(cwd, "node_modules/@acme"), { recursive: true });
  await Bun.$`ln -s ../../packages/kit ${join(cwd, "node_modules/@acme/kit")}`.quiet();
  // An existing baseline for one of the stories.
  await mkdir(join(cwd, "__snapshots__"), { recursive: true });
  await writeFile(join(cwd, "__snapshots__/@acme--kit--Ui--Badge--Badge-dark.png"), "");

  const config = await loadConfig(cwd);
  const { stories } = await scanStories(config, cwd);
  ({ components, unlinked, warnings } = await collectComponents(cwd, config, stories));
});

afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const byName = (name: string) => components.find((c) => c.name === name)!;

describe("collectComponents", () => {
  test("credits a story file to its same-named module, not to helpers it renders", () => {
    expect(components.map((c) => c.name)).toEqual(["Badge", "JobBoard", "JobHeader", "JobLog"]);
  });

  test("reads the declaration, its doc comment and both import paths", () => {
    const badge = byName("Badge");
    expect(badge.file).toBe("packages/kit/src/ui/badge.tsx");
    expect(badge.package).toBe("@acme/kit");
    expect(badge.description).toBe("A short status label.\n\nUse it inline next to the thing it describes.");
    expect(badge.import).toBe("import { Badge } from '@acme/kit/ui'");
    expect(badge.localImport).toBe("import { Badge } from '@/ui/badge'");
  });

  test("reads cva variants with their defaults and the doc comments on axes and values", () => {
    expect(byName("Badge").variants).toEqual([
      {
        name: "tone",
        description: "How loud the badge is.",
        default: "plain",
        values: [
          { name: "plain", description: "Neutral facts: counts, labels." },
          { name: "danger", description: "Something went wrong and needs a look." },
        ],
      },
      { name: "size", default: "md", values: [{ name: "sm" }, { name: "md" }] },
    ]);
  });

  test("lists the stories with their doc comments and existing baselines", () => {
    expect(byName("Badge").stories).toEqual([
      {
        file: "packages/kit/src/ui/badge.stories.tsx",
        stories: [
          {
            key: "@acme/kit/Ui/Badge--Badge",
            description: "The default tone.",
            baselines: ["__snapshots__/@acme--kit--Ui--Badge--Badge-dark.png"],
          },
          { key: "@acme/kit/Ui/Badge--BadgeDanger" },
        ],
      },
    ]);
  });

  test("falls back to the sibling components a file renders and credits each story to what it renders", () => {
    const keys = (name: string) => byName(name).stories.flatMap((g) => g.stories.map((s) => s.key));
    expect(keys("JobHeader")).toEqual(["@acme/app/Job/Job-detail--JobDetailHeader"]);
    expect(keys("JobLog")).toEqual(["@acme/app/Job/Job-detail--JobDetailLog"]);
    expect(byName("JobHeader").description).toBe("The job's title row.");
    expect(byName("JobHeader").import).toBeUndefined();
    expect(byName("JobHeader").localImport).toBe("import { JobHeader } from '@/job/job-parts'");
  });

  test("an @component tag names a component the file only reaches through a harness", () => {
    expect(byName("JobBoard").stories.flatMap((g) => g.stories.map((s) => s.key))).toEqual([
      "@acme/app/Job/Job-board--JobBoard",
    ]);
  });

  test("a component without a doc comment says so, and one without variants omits them", () => {
    expect(byName("JobBoard").description).toBeNull();
    expect(byName("JobBoard").variants).toBeUndefined();
  });

  test("reports files without a component and tags that resolve to nothing", () => {
    expect(unlinked).toEqual(["packages/app/src/job/orphan.stories.tsx"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("@component Missing");
  });
});

describe("searchComponents", () => {
  test("an exact name ranks first", () => {
    expect(searchComponents(components, "badge")[0]!.name).toBe("Badge");
  });

  test("matches variant documentation", () => {
    expect(searchComponents(components, "went wrong").map((c) => c.name)).toEqual(["Badge"]);
  });

  test("a story note alone does not make a component match", () => {
    expect(searchComponents(components, "dialog")).toEqual([]);
    expect(searchComponents(components, "log retry").map((c) => c.name)).toEqual(["JobLog"]);
  });

  test("components matching more terms rank above those matching fewer", () => {
    expect(searchComponents(components, "job title").map((c) => c.name)).toEqual(["JobHeader", "JobBoard", "JobLog"]);
  });
});

describe("output", () => {
  test("the index is one short record per component", () => {
    expect(summarize(byName("Badge"))).toEqual({ name: "Badge", import: "@acme/kit/ui", summary: "A short status label." });
    expect(summarize(byName("JobBoard"))).toEqual({ name: "JobBoard", import: "@/job/job-board", summary: null });
  });

  test("the full view marks a missing description and groups stories by file", () => {
    const text = formatComponent(byName("JobBoard"));
    expect(text).toContain("(no description)");
    expect(text).toContain("stories  packages/app/src/job/job-board.stories.tsx\n    @acme/app/Job/Job-board--JobBoard");
  });
});

describe("parseDocComment", () => {
  test("splits description and tags, tags spanning lines", () => {
    expect(parseDocComment("/**\n * Text.\n *\n * @deprecated Use X\n *   instead.\n * @component A, B\n */")).toEqual({
      description: "Text.",
      tags: [
        { name: "deprecated", text: "Use X\n  instead." },
        { name: "component", text: "A, B" },
      ],
    });
  });
});
