import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "path";
import type { SnapshotReport } from "./report-model.ts";

const repoRoot = join(import.meta.dir, "..", "..");

/**
 * A whole run against a project on disk, the way the CLI drives it: two
 * stories, one of which renders a component from its own file.
 */
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "storybun-run-"));
  // The project resolves react and playwright as an installed one would.
  await symlink(join(repoRoot, "node_modules"), join(dir, "node_modules"));
  await Bun.write(join(dir, "package.json"), `{ "name": "fixture" }\n`);
  await Bun.write(
    join(dir, "storybun.config.ts"),
    `export default { snapshot: { viewports: [{ width: 320, height: 200 }], concurrency: 2, settleTimeout: 5000 } };\n`,
  );
  await Bun.write(join(dir, "card.tsx"), card("#2563eb"));
  await Bun.write(
    join(dir, "card.stories.tsx"),
    `import { Card } from "./card";\nexport const Filled = () => <Card />;\n`,
  );
  await Bun.write(
    join(dir, "label.stories.tsx"),
    `export const Plain = () => <p style={{ color: "#111", background: "#eee", margin: 0 }}>label</p>;\n`,
  );
}, 30_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function card(color: string): string {
  return `export const Card = () => <div style={{ width: 120, height: 60, background: "${color}", color: "#fff" }}>card</div>;\n`;
}

/** Runs `storybun snapshot` in the project, as its own process, and returns its exit code and report. */
async function run(...flags: string[]) {
  const child = Bun.spawn(["bun", join(repoRoot, "src", "cli.ts"), "snapshot", "--json", "--quiet", ...flags], {
    cwd: dir,
    stdout: "ignore",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  const report = (await Bun.file(join(dir, "__snapshots__", "report.json")).json()) as SnapshotReport;
  return {
    exitCode,
    summary: report.summary,
    /** `story key: status` of every capture the run took. */
    captured: report.results.map((r) => `${r.storyKey}: ${r.status}`),
  };
}

describe("a snapshot run captures only what changed since the baselines", () => {
  test("the first run has nothing to go on and captures every story", async () => {
    const first = await run("--update");
    expect(first.exitCode).toBe(0);
    expect(first.captured).toEqual(["Card--Filled: updated", "Label--Plain: updated"]);
    expect(first.summary.unchanged).toBe(0);
  }, 60_000);

  test("with nothing edited, the next run captures nothing and passes", async () => {
    const again = await run();
    expect(again.exitCode).toBe(0);
    expect(again.captured).toEqual([]);
    expect(again.summary.unchanged).toBe(2);
  }, 60_000);

  test("an edited component is captured through its story, and stays due until its baseline is accepted", async () => {
    await Bun.write(join(dir, "card.tsx"), card("#dc2626"));

    const changed = await run();
    expect(changed.exitCode).toBe(1);
    expect(changed.captured).toEqual(["Card--Filled: changed"]);
    expect(changed.summary.unchanged).toBe(1);

    // The baseline still shows the old card, so the run must not start
    // vouching for it.
    expect((await run()).captured).toEqual(["Card--Filled: changed"]);

    const accepted = await run("--update");
    expect(accepted.captured).toEqual(["Card--Filled: updated"]);
    expect((await run()).captured).toEqual([]);
  }, 120_000);

  test("an edit that renders the same pixels is captured once, passes, and is then left alone", async () => {
    await Bun.write(join(dir, "card.tsx"), card("#dc2626").replace("<div ", `<div data-kind="card" `));

    const same = await run();
    expect(same.exitCode).toBe(0);
    expect(same.captured).toEqual(["Card--Filled: pass"]);
    expect((await run()).captured).toEqual([]);
  }, 60_000);

  test("a story whose baseline is gone is captured again", async () => {
    await unlink(join(dir, "__snapshots__", "Label--Plain.png"));
    expect((await run()).captured).toEqual(["Label--Plain: new"]);
  }, 60_000);

  test("--all captures every story regardless", async () => {
    const all = await run("--all");
    expect(all.captured).toEqual(["Card--Filled: pass", "Label--Plain: pass"]);
    expect(all.summary.unchanged).toBe(0);
  }, 60_000);
});
