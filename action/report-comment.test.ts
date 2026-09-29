import { describe, test, expect } from "bun:test";
import type { ReportEntry, SnapshotReport } from "../src/snapshot/report-model.ts";
import { COMMENT_MARKER, LIST_LIMIT, buildComment, buildStepSummary, headline, needsReview } from "./report-comment.ts";
import { findStickyComment, upsertStickyComment, type GitHubApi } from "./comment.ts";

function entry(storyKey: string, status: ReportEntry["status"], extra: Partial<ReportEntry> = {}): ReportEntry {
  return {
    storyKey,
    mode: "light",
    viewport: { width: 1280, height: 720 },
    status,
    diffPercent: status === "changed" ? 12.34 : null,
    dimensions: { baseline: null, actual: null },
    files: { baseline: `${storyKey}.png`, actual: null, diff: status === "changed" ? `${storyKey}.diff.png` : null },
    error: null,
    ...extra,
  };
}

function report(results: ReportEntry[], overrides: Partial<SnapshotReport["summary"]> = {}): SnapshotReport {
  const count = (s: ReportEntry["status"]) => results.filter((r) => r.status === s).length;
  return {
    version: 1,
    generatedAt: "2026-09-29T10:00:00.000Z",
    outDir: "__snapshots__",
    commit: "0123456789abcdef",
    summary: {
      total: results.length,
      passed: count("pass"),
      changed: count("changed"),
      new: count("new"),
      removed: count("removed"),
      captureFailed: count("capture-failed"),
      updated: count("updated"),
      exitCode: count("changed") + count("capture-failed") > 0 ? 1 : 0,
      ...overrides,
    },
    config: { threshold: 0.1, viewports: [{ width: 1280, height: 720 }], modes: ["light"], clock: null, locale: "en-US", timezoneId: "UTC" },
    results,
  };
}

describe("buildComment", () => {
  test("a passing run is one short line with the marker and the commit", () => {
    const body = buildComment(report([entry("A--B", "pass"), entry("C--D", "pass")]));
    expect(body).toBe(`${COMMENT_MARKER}\nVisual snapshots match the baseline at \`0123456\`.`);
  });

  test("lists changed, new, removed and failed stories with a table and the report link", () => {
    const body = buildComment(
      report([
        entry("Components/Button--Primary", "changed"),
        entry("Components/Card--Wide", "changed", { files: { baseline: "x.png", actual: "x.actual.png", diff: null } }),
        entry("Components/Badge--Small", "new"),
        entry("Old--Gone", "removed", { mode: null, viewport: null }),
        entry("Timeline--Empty", "capture-failed", { error: "rendered nothing" }),
        entry("Fine--One", "pass"),
      ]),
      { reportUrl: "https://assets.example/pr-1/abc/report.html" },
    );
    expect(body.startsWith(COMMENT_MARKER + "\n")).toBe(true);
    expect(body).toContain("### Visual snapshots: 2 changed, 1 new, 1 removed, 1 could not be captured");
    expect(body).toContain("| 1 | 2 | 1 | 1 | 1 |");
    expect(body).toContain("**Changed** (2)\n- `Components/Button--Primary` [light] (12.3%)\n- `Components/Card--Wide` [light] (size changed)");
    expect(body).toContain("**New** (1)\n- `Components/Badge--Small` [light]");
    expect(body).toContain("**Removed** (1)\n- `Old--Gone`\n");
    expect(body).toContain("**Could not be captured** (1)\n- `Timeline--Empty` [light]: rendered nothing");
    expect(body).toContain("[Open the report](https://assets.example/pr-1/abc/report.html) for before / after / diff of every story at `0123456`.");
    expect(body).not.toContain("Fine--One");
  });

  test("caps each list and says how many more there are", () => {
    const many = Array.from({ length: LIST_LIMIT + 3 }, (_, i) => entry(`S--${i}`, "changed"));
    const body = buildComment(report(many));
    expect(body.match(/^- `S--/gm)).toHaveLength(LIST_LIMIT);
    expect(body).toContain(`- +3 more`);
  });

  test("without a report url it says how to get the images locally", () => {
    const body = buildComment(report([entry("A--B", "changed")]));
    expect(body).toContain("Run `storybun snapshot --html` locally");
    expect(body).not.toContain("Open the report");
  });

  test("neutralises backticks in story keys and errors", () => {
    const body = buildComment(report([entry("Evil`--`Key", "capture-failed", { error: "boom `x`" })]));
    expect(body).toContain("`Evil'--'Key` [light]: boom 'x'");
  });

  test("a commit passed in wins over the one in the report", () => {
    const body = buildComment(report([entry("A--B", "pass")]), { commit: "fedcba9876543210" });
    expect(body).toContain("at `fedcba9`");
  });
});

describe("headline / needsReview / step summary", () => {
  test("an update run is not something to review", () => {
    const r = report([entry("A--B", "updated")]);
    expect(needsReview(r)).toBe(false);
    expect(headline(r)).toBe("1 updated");
  });

  test("the job summary carries the table and the link", () => {
    const text = buildStepSummary(report([entry("A--B", "changed")]), "https://x/report.html");
    expect(text).toContain("## Visual snapshots: 1 changed");
    expect(text).toContain("| 0 | 1 | 0 | 0 | 0 |");
    expect(text).toContain("[Open the report](https://x/report.html)");
  });
});

describe("sticky comment upsert", () => {
  function fakeApi(existing: { id: number; body: string }[][]): { api: GitHubApi; calls: { method: string; url: string; body?: unknown }[] } {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const api: GitHubApi = {
      apiUrl: "https://api.test",
      token: "t",
      repository: "org/repo",
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, url: String(url), body });
        if (method === "GET") {
          const page = Number(new URL(String(url)).searchParams.get("page"));
          return Response.json(existing[page - 1] ?? []);
        }
        return Response.json({ id: 99 });
      }) as typeof fetch,
    };
    return { api, calls };
  }

  test("creates the comment when none carries the marker", async () => {
    const { api, calls } = fakeApi([[{ id: 1, body: "unrelated" }]]);
    expect(await upsertStickyComment(api, 7, "new body")).toBe("created");
    expect(calls.at(-1)).toMatchObject({ method: "POST", url: "https://api.test/repos/org/repo/issues/7/comments", body: { body: "new body" } });
  });

  test("updates the existing marked comment, even on a later page", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i, body: "noise" }));
    const { api, calls } = fakeApi([page1, [{ id: 500, body: `${COMMENT_MARKER}\nold` }]]);
    expect(await findStickyComment(api, 7)).toMatchObject({ id: 500 });
    expect(await upsertStickyComment(api, 7, "fresh")).toBe("updated");
    expect(calls.at(-1)).toMatchObject({ method: "PATCH", url: "https://api.test/repos/org/repo/issues/comments/500", body: { body: "fresh" } });
    expect(calls.filter((c) => c.method === "GET").length).toBeGreaterThanOrEqual(2);
  });

  test("sends the token and the API version on every request", async () => {
    let headers: Record<string, string> = {};
    const api: GitHubApi = {
      apiUrl: "https://api.test",
      token: "secret",
      repository: "org/repo",
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        headers = init?.headers as Record<string, string>;
        return Response.json([]);
      }) as typeof fetch,
    };
    await findStickyComment(api, 1);
    expect(headers.authorization).toBe("Bearer secret");
    expect(headers["x-github-api-version"]).toBe("2022-11-28");
  });

  test("a failed request surfaces the status and body", async () => {
    const api: GitHubApi = {
      apiUrl: "https://api.test",
      token: "t",
      repository: "org/repo",
      fetch: (async () => new Response("Resource not accessible by integration", { status: 403 })) as unknown as typeof fetch,
    };
    await expect(findStickyComment(api, 1)).rejects.toThrow(/403 Resource not accessible/);
  });
});
