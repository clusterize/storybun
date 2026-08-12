import { describe, test, expect } from "bun:test";
import { resolveShotMode } from "./shot.ts";

const modes = {
  light: { colorScheme: "light" as const },
  dark: { colorScheme: "dark" as const },
};

describe("resolveShotMode", () => {
  test("no modes configured and none requested means no mode, like an unconfigured baseline run", () => {
    expect(resolveShotMode({}, undefined)).toEqual({ ok: true, name: undefined, mode: undefined });
  });

  test("omitted, the first configured mode is used so the shot matches the baseline run", () => {
    expect(resolveShotMode(modes, undefined)).toEqual({ ok: true, name: "light", mode: modes.light });
  });

  test("an explicit configured mode is used", () => {
    expect(resolveShotMode(modes, "dark")).toEqual({ ok: true, name: "dark", mode: modes.dark });
  });

  test("an unknown mode is an error naming the configured ones, not a silent default render", () => {
    const result = resolveShotMode(modes, "drak");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('"drak"');
    expect(result.message).toContain("light, dark");
  });

  test("--mode with no modes configured is an error", () => {
    const result = resolveShotMode({}, "dark");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("no snapshot modes are configured");
  });
});
