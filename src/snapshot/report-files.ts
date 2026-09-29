import { dirname, isAbsolute, join, relative } from "path";
import { mkdir } from "node:fs/promises";
import type { SnapshotReport } from "./report-model.ts";
import { renderReportHtml, type ReportTemplate } from "./report-html.tsx";

/**
 * `--json` / `--html` values: `true` means the default file inside `outDir`,
 * a string is a path relative to the project root (or absolute).
 */
export function resolveReportPath(
  value: string | true,
  cwd: string,
  outDir: string,
  defaultName: string,
): string {
  if (value === true) return join(outDir, defaultName);
  return isAbsolute(value) ? value : join(cwd, value);
}

/** `img src` prefix that reaches `outDir` from the directory holding the HTML file. */
export function imagePrefixFor(htmlPath: string, outDir: string): string {
  const rel = relative(dirname(htmlPath), outDir).split("\\").join("/");
  return rel === "" ? "" : `${rel}/`;
}

export async function writeJsonReport(path: string, report: SnapshotReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(report, null, 2) + "\n");
}

export async function writeHtmlReport(
  path: string,
  report: SnapshotReport,
  outDir: string,
  template?: ReportTemplate,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, renderReportHtml(report, imagePrefixFor(path, outDir), template));
}
