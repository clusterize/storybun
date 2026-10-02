import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";

let cwd: string;
let warn: ReturnType<typeof spyOn>;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "storybun-config-"));
  warn = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  warn.mockRestore();
  await rm(cwd, { recursive: true, force: true });
});

describe("loadConfig snapshot options", () => {
  test("defaults settleTimeout to ten seconds and carries no waitTimeout", async () => {
    const config = await loadConfig(cwd);
    expect(config.snapshot.settleTimeout).toBe(10_000);
    expect("waitTimeout" in config.snapshot).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  test("warns once about a deprecated waitTimeout and drops it from the resolved config", async () => {
    await Bun.write(
      join(cwd, "storybun.config.ts"),
      `export default { snapshot: { waitTimeout: 5000, settleTimeout: 4000 } };`,
    );

    const config = await loadConfig(cwd);

    expect(config.snapshot.settleTimeout).toBe(4000);
    expect("waitTimeout" in config.snapshot).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain("snapshot.waitTimeout (5000ms) is deprecated and ignored");
    expect(message).toContain("storybun.config.ts");
  });

  test("stays quiet about waitTimeout: 0, which never did anything", async () => {
    await Bun.write(join(cwd, "storybun.config.ts"), `export default { snapshot: { waitTimeout: 0 } };`);

    const config = await loadConfig(cwd);

    expect("waitTimeout" in config.snapshot).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
