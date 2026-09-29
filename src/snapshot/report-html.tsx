import { isAbsolute, join } from "path";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReportEntry, ReportStatus, SnapshotReport } from "./report-model.ts";

/**
 * What a report template receives. The default template below and any custom
 * one configured under `snapshot.report.component` get the same props.
 *
 * A template is rendered once, in Bun, with `renderToStaticMarkup`: there is
 * no browser, no state, no effects, and no client bundle. Interactivity has to
 * come from what static HTML offers (`<details>`, anchors) or an inline
 * `<script>` string the template emits itself.
 */
export interface ReportTemplateProps {
  report: SnapshotReport;
  /**
   * Prefix that turns a `files.*` path from the report into an `img src`
   * relative to the HTML file: `""` when the report sits inside `outDir`,
   * otherwise a relative directory ending in `/`.
   */
  imagePrefix: string;
}

export type ReportTemplate = ComponentType<ReportTemplateProps>;

const STATUS_LABEL: Record<ReportStatus, string> = {
  pass: "passed",
  changed: "changed",
  new: "new",
  removed: "removed",
  "capture-failed": "capture failed",
  updated: "updated",
};

/** Statuses a reviewer needs to look at; the rest is folded away. */
const ATTENTION: ReadonlySet<ReportStatus> = new Set(["changed", "new", "removed", "capture-failed"]);

function needsAttention(entries: ReportEntry[]): boolean {
  return entries.some((e) => ATTENTION.has(e.status));
}

function dims(d: { width: number; height: number } | null): string {
  return d ? `${d.width}\u00d7${d.height}` : "?";
}

function entryLabel(entry: ReportEntry): string {
  const parts: string[] = [];
  if (entry.mode) parts.push(entry.mode);
  if (entry.viewport) {
    parts.push(entry.viewport.name ?? `${entry.viewport.width}\u00d7${entry.viewport.height}`);
  }
  return parts.join(" \u00b7 ");
}

function groupByStory(entries: ReportEntry[]): [string, ReportEntry[]][] {
  const groups = new Map<string, ReportEntry[]>();
  for (const e of entries) {
    let list = groups.get(e.storyKey);
    if (!list) groups.set(e.storyKey, (list = []));
    list.push(e);
  }
  return [...groups.entries()];
}

function Image({
  prefix,
  file,
  caption,
}: {
  prefix: string;
  file: string;
  caption: string;
}) {
  return (
    <figure>
      <figcaption>{caption}</figcaption>
      <img src={`${prefix}${file}`} alt={caption} loading="lazy" />
    </figure>
  );
}

function Entry({ entry, prefix }: { entry: ReportEntry; prefix: string }) {
  const { files, dimensions } = entry;
  const label = entryLabel(entry);
  const dimensionChange =
    entry.status === "changed" && files.diff === null && dimensions.baseline && dimensions.actual;

  return (
    <div className={`entry status-${entry.status}`}>
      <div className="entry-head">
        <span className="badge">{STATUS_LABEL[entry.status]}</span>
        {label && <span className="label">{label}</span>}
        {entry.status === "changed" && entry.diffPercent !== null && (
          <span className="detail">{entry.diffPercent.toFixed(1)}% diff</span>
        )}
        {dimensionChange && (
          <span className="detail">
            {dims(dimensions.baseline)} {"\u2192"} {dims(dimensions.actual)}
          </span>
        )}
        {entry.status === "capture-failed" && entry.error && (
          <span className="detail error">{entry.error}</span>
        )}
      </div>
      {entry.status === "changed" && (
        <div className="images">
          {files.baseline && <Image prefix={prefix} file={files.baseline} caption="before" />}
          {files.actual && <Image prefix={prefix} file={files.actual} caption="after" />}
          {files.diff && <Image prefix={prefix} file={files.diff} caption="diff" />}
        </div>
      )}
      {entry.status !== "changed" && entry.status !== "capture-failed" && files.baseline && (
        <div className="images">
          <Image
            prefix={prefix}
            file={files.baseline}
            caption={
              entry.status === "pass" ? "baseline" : entry.status === "removed" ? "last baseline" : STATUS_LABEL[entry.status]
            }
          />
        </div>
      )}
    </div>
  );
}

function Story({ storyKey, entries, prefix }: { storyKey: string; entries: ReportEntry[]; prefix: string }) {
  return (
    <article className="story">
      <h2>{storyKey}</h2>
      {entries.map((entry, i) => (
        <Entry key={i} entry={entry} prefix={prefix} />
      ))}
    </article>
  );
}

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #ffffff; --fg: #1a1a1a; --muted: #666; --line: #ddd; --card: #f6f6f6;
  --pass: #1a7f37; --changed: #b35900; --new: #0b5cad; --removed: #8250df;
  --failed: #c62828; --updated: #1a7f37; --badge-fg: #fff;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111; --fg: #e6e6e6; --muted: #999; --line: #333; --card: #1b1b1b;
    --pass: #2ea043; --changed: #d29922; --new: #4493f8; --removed: #a371f7;
    --failed: #f85149; --updated: #2ea043; --badge-fg: #111;
  }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; background: var(--bg); color: var(--fg);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 0 0 8px; font-weight: 600; word-break: break-all; }
.meta { color: var(--muted); margin: 0 0 12px; }
.counts { list-style: none; padding: 0; margin: 0 0 24px; display: flex; flex-wrap: wrap; gap: 8px; }
.counts li { padding: 2px 10px; border-radius: 12px; background: var(--card); border: 1px solid var(--line); }
.counts li.zero { color: var(--muted); }
.story { border-top: 1px solid var(--line); padding: 16px 0; }
.entry { background: var(--card); border-radius: 6px; padding: 10px 12px; margin: 0 0 10px; }
.entry-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 0 0 8px; }
.badge { font-size: 12px; font-weight: 600; padding: 1px 8px; border-radius: 10px;
  color: var(--badge-fg); background: var(--muted); }
.status-pass .badge, .status-updated .badge { background: var(--pass); }
.status-changed .badge { background: var(--changed); }
.status-new .badge { background: var(--new); }
.status-removed .badge { background: var(--removed); }
.status-capture-failed .badge { background: var(--failed); }
.detail { color: var(--muted); }
.detail.error { color: var(--failed); font-family: ui-monospace, monospace; font-size: 13px; }
.images { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start; }
figure { margin: 0; max-width: 100%; }
figcaption { color: var(--muted); font-size: 12px; margin: 0 0 4px; }
img { display: block; max-width: 100%; height: auto; border: 1px solid var(--line);
  background: repeating-conic-gradient(var(--line) 0 25%, transparent 0 50%) 0 0 / 16px 16px; }
details.quiet { border-top: 1px solid var(--line); padding: 12px 0; }
details.quiet > summary { cursor: pointer; font-weight: 600; }
`;

/** The built-in report page. Exported so a custom template can wrap or reuse it. */
export function DefaultReport({ report, imagePrefix }: ReportTemplateProps) {
  const { summary, config } = report;
  const groups = groupByStory(report.results);
  const attention = groups.filter(([, entries]) => needsAttention(entries));
  const quiet = groups.filter(([, entries]) => !needsAttention(entries));

  const counts: [string, number, string][] = [
    ["passed", summary.passed, "pass"],
    ["changed", summary.changed, "changed"],
    ["new", summary.new, "new"],
    ["removed", summary.removed, "removed"],
    ["capture failed", summary.captureFailed, "capture-failed"],
    ["updated", summary.updated, "updated"],
  ];

  const meta: string[] = [];
  if (report.commit) meta.push(`commit ${report.commit.slice(0, 7)}`);
  meta.push(`threshold ${config.threshold}`);
  if (config.clock) meta.push(`clock frozen at ${config.clock}`);
  meta.push(`generated ${report.generatedAt}`);

  const quietLabel = summary.updated > 0 ? "updated" : "passed";

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Snapshot report</title>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        <header>
          <h1>Snapshot report</h1>
          <p className="meta">{meta.join(" \u00b7 ")}</p>
          <ul className="counts">
            {counts
              .filter(([, n, key]) => n > 0 || key === "pass" || key === "changed")
              .map(([label, n, key]) => (
                <li key={key} className={n === 0 ? "zero" : key}>
                  {n} {label}
                </li>
              ))}
          </ul>
        </header>
        <main>
          {attention.map(([storyKey, entries]) => (
            <Story key={storyKey} storyKey={storyKey} entries={entries} prefix={imagePrefix} />
          ))}
          {quiet.length > 0 && (
            <details className="quiet">
              <summary>
                {quiet.length} {quietLabel} {quiet.length === 1 ? "story" : "stories"}
              </summary>
              {quiet.map(([storyKey, entries]) => (
                <Story key={storyKey} storyKey={storyKey} entries={entries} prefix={imagePrefix} />
              ))}
            </details>
          )}
          {groups.length === 0 && <p className="meta">No stories in this run.</p>}
        </main>
      </body>
    </html>
  );
}

export function renderReportHtml(
  report: SnapshotReport,
  imagePrefix: string,
  Template: ReportTemplate = DefaultReport,
): string {
  return "<!doctype html>\n" + renderToStaticMarkup(<Template report={report} imagePrefix={imagePrefix} />) + "\n";
}

/**
 * Imports the template configured under `snapshot.report.component`: a module
 * whose default export (or a named `Report` export) is a React component
 * taking `ReportTemplateProps`.
 */
export async function loadReportTemplate(cwd: string, modulePath: string): Promise<ReportTemplate> {
  const absolute = isAbsolute(modulePath) ? modulePath : join(cwd, modulePath);
  const mod = await import(absolute);
  const Template = mod.default ?? mod.Report;
  if (typeof Template !== "function") {
    throw new Error(
      `snapshot.report.component (${modulePath}) must export a React component as its default export or as "Report".`,
    );
  }
  return Template as ReportTemplate;
}
