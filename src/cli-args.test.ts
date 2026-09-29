import { describe, test, expect } from "bun:test";
import { flagValue, parseOptionalPathFlag } from "./cli-args.ts";

describe("parseOptionalPathFlag", () => {
  test("absent flag is undefined", () => {
    expect(parseOptionalPathFlag(["--update"], "--json")).toBeUndefined();
  });

  test("bare flag is true", () => {
    expect(parseOptionalPathFlag(["--json"], "--json")).toBe(true);
    expect(parseOptionalPathFlag(["--json", "--html"], "--json")).toBe(true);
    expect(parseOptionalPathFlag(["--json", "--html"], "--html")).toBe(true);
  });

  test("flag followed by a path yields the path", () => {
    expect(parseOptionalPathFlag(["--json", "out/report.json"], "--json")).toBe("out/report.json");
  });

  test("both report flags parse independently in one argument list", () => {
    const args = ["--json", "--html", "docs/snapshots.html", "--codeowners"];
    expect(parseOptionalPathFlag(args, "--json")).toBe(true);
    expect(parseOptionalPathFlag(args, "--html")).toBe("docs/snapshots.html");
  });
});

describe("flagValue", () => {
  test("returns the following argument, or undefined when it is a flag", () => {
    expect(flagValue(["--filter", "Button"], "--filter")).toBe("Button");
    expect(flagValue(["--filter", "--update"], "--filter")).toBeUndefined();
    expect(flagValue(["--update"], "--filter")).toBeUndefined();
  });
});
