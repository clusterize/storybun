import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageImages } from "./stage-images.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "storybun-stage-"));
  await Bun.write(join(dir, "snap", "A.png"), "a");
  await Bun.write(join(dir, "snap", "A.actual.png"), "a2");
  await Bun.write(join(dir, "snap", "B.png"), "b");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("stageImages", () => {
  test("links exactly the listed files and nothing else", async () => {
    const stage = join(dir, "stage");
    const staged = await stageImages(["A.png", "A.actual.png"], join(dir, "snap"), stage);
    expect(staged).toBe(2);
    expect((await readdir(stage)).sort()).toEqual(["A.actual.png", "A.png"]);
    // A hard link, not a copy: same inode, no extra bytes written.
    expect((await stat(join(stage, "A.png"))).ino).toBe((await stat(join(dir, "snap", "A.png"))).ino);
  });

  test("a listed file that is missing is skipped, not fatal", async () => {
    const stage = join(dir, "stage");
    expect(await stageImages(["Gone.png", "B.png"], join(dir, "snap"), stage)).toBe(1);
    expect(await readdir(stage)).toEqual(["B.png"]);
  });
});
