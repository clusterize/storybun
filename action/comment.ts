// Creates or updates the one sticky comment on the pull request.
// Env: REPORT_PATH, PR_NUMBER, GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL,
// optional REPORT_URL, COMMENT_ON_PASS ("true" | "false").
import type { SnapshotReport } from "../src/snapshot/report-model.ts";
import { COMMENT_MARKER, buildComment, needsReview } from "./report-comment.ts";

export interface GitHubApi {
  fetch: typeof fetch;
  apiUrl: string;
  token: string;
  repository: string;
}

interface IssueComment {
  id: number;
  body?: string;
}

async function request(api: GitHubApi, method: string, path: string, body?: unknown): Promise<Response> {
  const res = await api.fetch(`${api.apiUrl}/repos/${api.repository}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${api.token}`,
      "x-github-api-version": "2022-11-28",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${method} ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res;
}

/** The existing sticky comment, found by its marker, across every page of comments. */
export async function findStickyComment(api: GitHubApi, prNumber: number): Promise<IssueComment | null> {
  for (let page = 1; page <= 50; page++) {
    const res = await request(api, "GET", `/issues/${prNumber}/comments?per_page=100&page=${page}`);
    const comments = (await res.json()) as IssueComment[];
    const hit = comments.find((c) => c.body?.includes(COMMENT_MARKER));
    if (hit) return hit;
    if (comments.length < 100) return null;
  }
  return null;
}

export async function upsertStickyComment(api: GitHubApi, prNumber: number, body: string): Promise<"created" | "updated"> {
  const existing = await findStickyComment(api, prNumber);
  if (existing) {
    await request(api, "PATCH", `/issues/comments/${existing.id}`, { body });
    return "updated";
  }
  await request(api, "POST", `/issues/${prNumber}/comments`, { body });
  return "created";
}

if (import.meta.main) {
  const env = process.env;
  const required = ["REPORT_PATH", "PR_NUMBER", "GITHUB_TOKEN", "GITHUB_REPOSITORY"] as const;
  for (const name of required) if (!env[name]) throw new Error(`${name} is not set`);

  const report = (await Bun.file(env.REPORT_PATH!).json()) as SnapshotReport;
  const api: GitHubApi = {
    fetch,
    apiUrl: env.GITHUB_API_URL ?? "https://api.github.com",
    token: env.GITHUB_TOKEN!,
    repository: env.GITHUB_REPOSITORY!,
  };
  const prNumber = Number(env.PR_NUMBER);

  if (!needsReview(report) && env.COMMENT_ON_PASS === "false") {
    // Nothing to look at and no pass comment wanted; but a stale comment from
    // an earlier round must not keep saying something changed.
    const existing = await findStickyComment(api, prNumber);
    if (existing) {
      await upsertStickyComment(api, prNumber, buildComment(report, { commit: env.GITHUB_SHA }));
      console.log("storybun: updated the sticky comment to the passing state");
    } else {
      console.log("storybun: nothing to review and comment-on-pass is off; no comment posted");
    }
  } else {
    const body = buildComment(report, { reportUrl: env.REPORT_URL || undefined, commit: env.GITHUB_SHA });
    const result = await upsertStickyComment(api, prNumber, body);
    console.log(`storybun: ${result} the sticky comment on #${prNumber}`);
  }
}
