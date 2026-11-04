import { isAbsolute, join } from "path";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReportDimensions, ReportEntry, ReportStatus, SnapshotReport } from "./report-model.ts";

/**
 * What a report template receives. The default template below and any custom
 * one configured under `snapshot.report.component` get the same props.
 *
 * A template is rendered once, in Bun, with `renderToStaticMarkup`: there is
 * no browser, no state, no effects, and no client bundle. Interactivity has to
 * come from what static HTML offers (`<details>`, radio inputs, anchors) or an
 * inline `<script>` string the template emits itself.
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

/** Order of the status filters in the toolbar. */
const STATUS_ORDER: ReportStatus[] = ["changed", "new", "removed", "capture-failed", "pass", "updated"];

/**
 * An image taller than this is cut off in the page, with a fade, and shown
 * whole in the full-screen view. Without the cap one tall page story pushes
 * every other story a few screens down.
 */
const SHOT_MAX_HEIGHT = 560;

function needsAttention(entries: ReportEntry[]): boolean {
  return entries.some((e) => ATTENTION.has(e.status));
}

function dims(d: { width: number; height: number } | null): string {
  return d ? `${d.width}×${d.height}` : "?";
}

function entryLabel(entry: ReportEntry): string {
  const parts: string[] = [];
  if (entry.mode) parts.push(entry.mode);
  if (entry.viewport) {
    parts.push(entry.viewport.name ?? `${entry.viewport.width}×${entry.viewport.height}`);
  }
  return parts.join(" · ");
}

interface StoryGroup {
  storyKey: string;
  entries: ReportEntry[];
  /** Position among all groups; the base of the ids the flip view needs. */
  index: number;
}

function groupByStory(entries: ReportEntry[]): StoryGroup[] {
  const groups = new Map<string, ReportEntry[]>();
  for (const e of entries) {
    let list = groups.get(e.storyKey);
    if (!list) groups.set(e.storyKey, (list = []));
    list.push(e);
  }
  return [...groups.entries()].map(([storyKey, list], index) => ({ storyKey, entries: list, index }));
}

/** `a/b/File--Export` → `["a/b/File", "Export"]`; a key without `--` is all name. */
function splitStoryKey(storyKey: string): [string, string] {
  const at = storyKey.lastIndexOf("--");
  return at === -1 ? ["", storyKey] : [storyKey.slice(0, at), storyKey.slice(at + 2)];
}

function isTall(d: ReportDimensions | null): boolean {
  return d !== null && d.height > SHOT_MAX_HEIGHT;
}

/**
 * Width and height attributes keep the page from jumping while thousands of
 * lazy images load, and `max-width: 100%` with `height: auto` then scales
 * the image down without ever scaling it up.
 */
function Img({ src, alt, d }: { src: string; alt: string; d: ReportDimensions | null }) {
  return <img src={src} alt={alt} loading="lazy" width={d?.width} height={d?.height} />;
}

function Image({
  prefix,
  file,
  caption,
  d,
}: {
  prefix: string;
  file: string;
  caption: string;
  d: ReportDimensions | null;
}) {
  return (
    <figure>
      <figcaption>{caption}</figcaption>
      <div className={`shot${isTall(d) ? " tall" : ""}`}>
        <Img src={`${prefix}${file}`} alt={caption} d={d} />
      </div>
    </figure>
  );
}

/**
 * Before and after stacked in one box, the after image clipped to the right
 * of a draggable divider. Both are scaled by the same factor, measured
 * against the larger of the two, so a story that changed size stays aligned
 * at its top-left corner instead of being stretched to fit.
 */
function Slider({ entry, prefix }: { entry: ReportEntry; prefix: string }) {
  const { files, dimensions } = entry;
  const b = dimensions.baseline;
  const a = dimensions.actual;
  const box = b && a ? { width: Math.max(b.width, a.width), height: Math.max(b.height, a.height) } : (a ?? b);
  const pct = (d: ReportDimensions | null) => (d && box ? `${(d.width / box.width) * 100}%` : "100%");
  return (
    <div className={`shot${isTall(box) ? " tall" : ""}`}>
      <div
        className="slider"
        style={{
          ["--pos" as string]: "50%",
          aspectRatio: box ? `${box.width} / ${box.height}` : undefined,
          maxWidth: box ? `${box.width}px` : undefined,
        }}
      >
        <img className="s-before" src={`${prefix}${files.baseline}`} alt="before" loading="lazy" style={{ width: pct(b) }} />
        <div className="s-after">
          <img src={`${prefix}${files.actual}`} alt="after" loading="lazy" style={{ width: pct(a) }} />
        </div>
        <span className="s-tag s-tag-before">before</span>
        <span className="s-tag s-tag-after">after</span>
        <input className="s-range" type="range" min={0} max={100} step={0.1} defaultValue={50} aria-label="Before/after divider" />
      </div>
    </div>
  );
}

/**
 * Before, after and diff of one changed capture, in several views of the
 * same images: a slider that wipes from before to after, a column grid, and
 * one image at a time in the same spot, so flipping between "before" and
 * "after" makes the change jump out. The tabs are a radio group driven by
 * CSS alone; only the slider's divider needs the page script to move.
 */
function Comparison({ uid, entry, prefix }: { uid: string; entry: ReportEntry; prefix: string }) {
  const { files, dimensions } = entry;
  const views: [string, string, string | null, ReportDimensions | null][] = [
    ["slider", "slider", null, null],
    ["grid", "side by side", null, null],
    ["before", "before", files.baseline, dimensions.baseline],
    ["after", "after", files.actual, dimensions.actual],
  ];
  if (files.diff) views.push(["diff", "diff", files.diff, dimensions.actual]);
  const columns = files.diff ? 3 : 2;

  return (
    <div className="compare">
      {views.map(([key], i) => (
        <input key={key} type="radio" className={`t-${key}`} id={`${uid}-${key}`} name={uid} defaultChecked={i === 0} />
      ))}
      <div className="tabs">
        {views.map(([key, label]) => (
          <label key={key} className={`l-${key}`} htmlFor={`${uid}-${key}`}>
            {label}
          </label>
        ))}
      </div>
      <div className="pane pane-slider single">
        <Slider entry={entry} prefix={prefix} />
      </div>
      <div className={`pane pane-grid images cols-${columns}`}>
        {files.baseline && <Image prefix={prefix} file={files.baseline} caption="before" d={dimensions.baseline} />}
        {files.actual && <Image prefix={prefix} file={files.actual} caption="after" d={dimensions.actual} />}
        {files.diff && <Image prefix={prefix} file={files.diff} caption="diff" d={dimensions.actual} />}
      </div>
      {views.slice(2).map(
        ([key, label, file, d]) =>
          file && (
            <div key={key} className={`pane pane-${key} single`}>
              <div className={`shot${isTall(d) ? " tall" : ""}`}>
                <Img src={`${prefix}${file}`} alt={label} d={d} />
              </div>
            </div>
          ),
      )}
    </div>
  );
}

const EXPAND_ICON = (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <path d="M8.5 1.5h4v4M5.5 12.5h-4v-4M12.5 1.5 8 6M1.5 12.5 6 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

function Entry({ uid, entry, prefix }: { uid: string; entry: ReportEntry; prefix: string }) {
  const { files, dimensions } = entry;
  const label = entryLabel(entry);
  const dimensionChange =
    entry.status === "changed" && files.diff === null && dimensions.baseline && dimensions.actual;
  const hasImage = entry.status === "changed" || (entry.status !== "capture-failed" && files.baseline !== null);

  return (
    <section className={`entry status-${entry.status}`} data-status={entry.status} data-mode={entry.mode ?? ""}>
      <div className="entry-head">
        <span className="badge">{STATUS_LABEL[entry.status]}</span>
        {label && <span className="label">{label}</span>}
        {entry.status === "changed" && entry.diffPercent !== null && (
          <span className="detail">{entry.diffPercent.toFixed(1)}% diff</span>
        )}
        {dimensionChange && (
          <span className="detail">
            {dims(dimensions.baseline)} {"→"} {dims(dimensions.actual)}
          </span>
        )}
        {entry.status === "capture-failed" && entry.error && (
          <span className="detail error">{entry.error}</span>
        )}
        {hasImage && (
          <button type="button" className="expand js-only" title="Full screen (click an image, too)" aria-label="Full screen">
            {EXPAND_ICON}
          </button>
        )}
      </div>
      {entry.status === "changed" && <Comparison uid={uid} entry={entry} prefix={prefix} />}
      {entry.status !== "changed" && entry.status !== "capture-failed" && files.baseline && (
        <div className="images cols-1">
          <Image
            prefix={prefix}
            file={files.baseline}
            d={dimensions.baseline}
            caption={
              entry.status === "pass" ? "baseline" : entry.status === "removed" ? "last baseline" : STATUS_LABEL[entry.status]
            }
          />
        </div>
      )}
    </section>
  );
}

function Story({ group, prefix }: { group: StoryGroup; prefix: string }) {
  const [path, name] = splitStoryKey(group.storyKey);
  return (
    <article className="story" id={`story-${group.index}`} data-key={group.storyKey.toLowerCase()}>
      <h2>
        <a href={`#story-${group.index}`} className="anchor">
          <span className="name">{name}</span>
          {path && <span className="path">{path}</span>}
        </a>
        {/* The full key, unsplit, for searching the page and for copying. */}
        <span className="key">{group.storyKey}</span>
      </h2>
      <div className="entries">
        {group.entries.map((entry, i) => (
          <Entry key={i} uid={`s${group.index}e${i}`} entry={entry} prefix={prefix} />
        ))}
      </div>
    </article>
  );
}

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #ffffff; --fg: #1a1a1a; --muted: #666; --line: #ddd; --card: #f6f6f6; --bar: rgba(255,255,255,.92);
  --pass: #1a7f37; --changed: #b35900; --new: #0b5cad; --removed: #8250df;
  --failed: #c62828; --updated: #1a7f37; --badge-fg: #fff; --focus: #0b5cad;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111; --fg: #e6e6e6; --muted: #999; --line: #333; --card: #1b1b1b; --bar: rgba(17,17,17,.92);
    --pass: #2ea043; --changed: #d29922; --new: #4493f8; --removed: #a371f7;
    --failed: #f85149; --updated: #2ea043; --badge-fg: #111; --focus: #4493f8;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
.no-js .js-only, .js .no-js-chip { display: none !important; }
button { font: inherit; color: inherit; }

/* Toolbar */
.top { position: sticky; top: 0; z-index: 10; background: var(--bar); backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--line); padding: 12px 24px; }
.top-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
h1 { font-size: 17px; margin: 0; }
.meta { color: var(--muted); margin: 0; font-size: 12px; }
.controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin-top: 10px; }
.counts { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 12px;
  background: var(--card); border: 1px solid var(--line); }
.chip.zero { color: var(--muted); }
button.chip { cursor: pointer; }
button.chip[aria-pressed="false"] { opacity: .45; }
button.chip[aria-pressed="false"] .dot { background: transparent; box-shadow: inset 0 0 0 1.5px var(--muted); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.chip.changed .dot { background: var(--changed); } .chip.new .dot { background: var(--new); }
.chip.removed .dot { background: var(--removed); } .chip.capture-failed .dot { background: var(--failed); }
.chip.pass .dot, .chip.updated .dot { background: var(--pass); }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.seg button { border: 0; background: none; padding: 3px 12px; cursor: pointer; color: var(--muted); }
.seg button + button { border-left: 1px solid var(--line); }
.seg button[aria-pressed="true"] { background: var(--fg); color: var(--bg); }
.search { padding: 4px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg);
  color: var(--fg); font: inherit; min-width: 220px; flex: 0 1 320px; }
.shown { color: var(--muted); font-size: 12px; margin-left: auto; }
.hint { color: var(--muted); font-size: 12px; }
kbd { font: 11px ui-monospace, monospace; border: 1px solid var(--line); border-bottom-width: 2px;
  border-radius: 4px; padding: 0 4px; }
button:focus-visible, input:focus-visible, a:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

/* Stories */
main { padding: 0 24px 64px; }
.story { border-bottom: 1px solid var(--line); padding: 16px 0; scroll-margin-top: 120px; }
.story.current > h2 .name { text-decoration: underline; text-decoration-color: var(--focus); text-underline-offset: 4px; }
h2 { font-size: 15px; margin: 0 0 8px; font-weight: 600; display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; }
h2 .anchor { color: inherit; text-decoration: none; display: contents; }
h2 .path { color: var(--muted); font-weight: 400; font-size: 12px; word-break: break-all; }
h2 .key { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.entries { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 480px), 1fr)); align-items: start; }
.entry { background: var(--card); border-radius: 8px; padding: 10px 12px; min-width: 0; }
.entry-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 0 0 8px; }
.expand { margin-left: auto; border: 1px solid var(--line); background: var(--bg); border-radius: 6px;
  padding: 3px 5px; cursor: pointer; line-height: 0; color: var(--muted); }
.expand:hover { color: var(--fg); }
.badge { font-size: 12px; font-weight: 600; padding: 1px 8px; border-radius: 10px;
  color: var(--badge-fg); background: var(--muted); }
.status-pass .badge, .status-updated .badge { background: var(--pass); }
.status-changed .badge { background: var(--changed); }
.status-new .badge { background: var(--new); }
.status-removed .badge { background: var(--removed); }
.status-capture-failed .badge { background: var(--failed); }
.detail { color: var(--muted); }
.detail.error { color: var(--failed); font-family: ui-monospace, monospace; font-size: 13px; flex-basis: 100%; }
.images { display: grid; gap: 12px; align-items: start; }
.images.cols-1 { grid-template-columns: minmax(0, 1fr); }
.images.cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.images.cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
figure { margin: 0; min-width: 0; }
figcaption { color: var(--muted); font-size: 12px; margin: 0 0 4px; }
img { display: block; max-width: 100%; height: auto; border: 1px solid var(--line);
  background: repeating-conic-gradient(var(--line) 0 25%, transparent 0 50%) 0 0 / 16px 16px; }
.shot { position: relative; }
.shot.tall { max-height: ${SHOT_MAX_HEIGHT}px; overflow: hidden; }
.shot.tall::after { content: "taller than shown · open full screen"; position: absolute; inset: auto 0 0 0;
  height: 64px; display: flex; align-items: flex-end; justify-content: center; padding-bottom: 8px;
  font-size: 12px; color: var(--muted); pointer-events: none;
  background: linear-gradient(transparent, var(--card) 85%); }
.js .shot img { cursor: zoom-in; }

/* Comparison tabs */
.compare { position: relative; }
.compare > input { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }
.tabs { display: flex; flex-wrap: wrap; gap: 2px; margin: 0 0 8px; border-bottom: 1px solid var(--line); }
.tabs label { padding: 4px 10px; cursor: pointer; color: var(--muted); border-bottom: 2px solid transparent;
  margin-bottom: -1px; user-select: none; }
.tabs label:hover { color: var(--fg); }
.compare > input:focus-visible ~ .tabs { outline: 2px solid var(--focus); outline-offset: 2px; }
.pane { display: none; }
.compare > input.t-slider:checked ~ .pane-slider,
.compare > input.t-grid:checked ~ .pane-grid,
.compare > input.t-before:checked ~ .pane-before,
.compare > input.t-after:checked ~ .pane-after,
.compare > input.t-diff:checked ~ .pane-diff { display: grid; }
.compare > input.t-slider:checked ~ .tabs .l-slider,
.compare > input.t-grid:checked ~ .tabs .l-grid,
.compare > input.t-before:checked ~ .tabs .l-before,
.compare > input.t-after:checked ~ .tabs .l-after,
.compare > input.t-diff:checked ~ .tabs .l-diff { color: var(--fg); border-bottom-color: var(--fg); font-weight: 600; }
.single { grid-template-columns: minmax(0, 1fr); }

/* Before/after slider */
.slider { position: relative; width: 100%; border: 1px solid var(--line); overflow: hidden;
  background: repeating-conic-gradient(var(--line) 0 25%, transparent 0 50%) 0 0 / 16px 16px; }
.slider img { position: absolute; top: 0; left: 0; max-width: none; height: auto; border: 0; background: none; }
.slider .s-before { position: relative; }
.s-after { position: absolute; inset: 0; clip-path: inset(0 0 0 var(--pos)); }
.slider::after { content: ""; position: absolute; top: 0; bottom: 0; left: var(--pos); width: 2px;
  margin-left: -1px; background: var(--focus); box-shadow: 0 0 0 1px rgba(0,0,0,.25); pointer-events: none; }
.s-range { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: ew-resize; }
.s-tag { position: absolute; top: 6px; font-size: 11px; padding: 0 6px; border-radius: 4px;
  background: rgba(0,0,0,.6); color: #fff; pointer-events: none; }
.s-tag-before { left: 6px; } .s-tag-after { right: 6px; }
.no-js .s-range { display: none; }

details.quiet { padding: 12px 0; }
details.quiet > summary { cursor: pointer; font-weight: 600; }
[hidden] { display: none !important; }

/* Full-screen view */
.lb { width: 100vw; height: 100vh; max-width: none; max-height: none; margin: 0; padding: 0; border: 0;
  background: var(--bg); color: var(--fg); }
.lb::backdrop { background: rgba(0,0,0,.6); }
.lb[open] { display: flex; flex-direction: column; }
.lb-bar { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--line); }
.lb-title { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lb-title .path { color: var(--muted); font-weight: 400; font-size: 12px; margin-left: 8px; }
.lb-pos { color: var(--muted); font-size: 12px; white-space: nowrap; }
.lb-bar .hint { margin-left: auto; white-space: nowrap; }
.lb-bar button { border: 1px solid var(--line); background: var(--card); border-radius: 6px; padding: 2px 10px; cursor: pointer; }
.lb-body { flex: 1; overflow: auto; padding: 16px; }
.lb-body .entry { background: none; padding: 0; }
.lb-body .entry-head .expand { display: none; }
.lb-body .shot.tall { max-height: none; overflow: visible; }
.lb-body .shot.tall::after { display: none; }
.lb-body .shot img { cursor: default; }
.lb-body .images.cols-1 img, .lb-body .single img { margin: 0 auto; }
.lb-body .slider { margin: 0 auto; }
@media (max-width: 720px) {
  .top, main { padding-left: 16px; padding-right: 16px; }
  .lb-bar .hint { display: none; }
}
`;

/**
 * The page script. Everything it adds sits on top of a page that already
 * works without it: the filters, the slider's divider, the full-screen view
 * and the keyboard shortcuts. It reads only the DOM, never report data, so
 * nothing from a story key can end up in it.
 */
const SCRIPT = `
(function () {
  var doc = document.documentElement;
  doc.classList.remove("no-js");
  doc.classList.add("js");
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var main = $("main");
  var entries = $$("main .entry");
  var stories = $$("main .story");
  var chips = $$("button.chip[data-status]");
  var modeButtons = $$(".seg button[data-mode]");
  var search = $(".search");
  var shown = $(".shown");
  var quiet = $("details.quiet");

  var available = chips.map(function (c) { return c.dataset.status; });
  var attention = available.filter(function (s) { return s !== "pass" && s !== "updated"; });
  var state = { status: new Set(attention.length ? attention : available), mode: "", q: "" };

  function readHash() {
    var p = new URLSearchParams(location.hash.slice(1));
    if (p.has("status")) state.status = new Set(p.get("status").split(",").filter(Boolean));
    if (p.has("mode")) state.mode = p.get("mode");
    if (p.has("q")) state.q = p.get("q");
  }
  function writeHash() {
    var p = new URLSearchParams();
    p.set("status", Array.from(state.status).join(","));
    if (state.mode) p.set("mode", state.mode);
    if (state.q) p.set("q", state.q);
    history.replaceState(null, "", "#" + p.toString());
  }

  function apply() {
    var q = state.q.trim().toLowerCase().split(/\\s+/).filter(Boolean);
    var counts = {};
    var visibleStories = 0;
    stories.forEach(function (story) {
      var key = story.dataset.key;
      var matches = q.every(function (t) { return key.indexOf(t) !== -1; });
      var any = false;
      $$(".entry", story).forEach(function (e) {
        var inMode = !state.mode || e.dataset.mode === state.mode;
        if (matches && inMode) counts[e.dataset.status] = (counts[e.dataset.status] || 0) + 1;
        var show = matches && inMode && state.status.has(e.dataset.status);
        e.hidden = !show;
        any = any || show;
      });
      story.hidden = !any;
      if (any) visibleStories++;
    });
    chips.forEach(function (c) {
      var s = c.dataset.status;
      c.setAttribute("aria-pressed", String(state.status.has(s)));
      $(".n", c).textContent = counts[s] || 0;
    });
    modeButtons.forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode)); });
    if (quiet) {
      quiet.hidden = !$$(".story", quiet).some(function (s) { return !s.hidden; });
      if (state.status.has("pass") || state.status.has("updated") || q.length) quiet.open = true;
    }
    shown.textContent = visibleStories + " of " + stories.length + " stories";
    writeHash();
  }

  chips.forEach(function (c) {
    c.addEventListener("click", function (ev) {
      var s = c.dataset.status;
      if (ev.altKey || ev.metaKey || ev.ctrlKey) state.status = new Set([s]);
      else if (state.status.has(s)) state.status.delete(s);
      else state.status.add(s);
      apply();
    });
  });
  modeButtons.forEach(function (b) {
    b.addEventListener("click", function () { state.mode = b.dataset.mode; apply(); });
  });
  if (search) search.addEventListener("input", function () { state.q = search.value; apply(); });

  // Slider divider: a transparent range input over the image.
  document.addEventListener("input", function (ev) {
    var t = ev.target;
    if (t.classList && t.classList.contains("s-range")) {
      t.closest(".slider").style.setProperty("--pos", t.value + "%");
    }
  });

  // Full-screen view
  var lb = $(".lb");
  var lbBody = $(".lb-body", lb);
  var current = -1;
  // The view picked in the full-screen view (slider, before, ...) carries
  // over to the next entry, so stepping through changes in "before" or
  // "diff" stays in it.
  var view = null;
  function visibleEntries() {
    return entries.filter(function (e) {
      var d = e.closest("details");
      return !e.closest("[hidden]") && (!d || d.open) && $(".shot", e);
    });
  }
  var list = [];
  function show(i) {
    if (!list.length) return;
    current = (i + list.length) % list.length;
    var src = list[current];
    var clone = src.cloneNode(true);
    clone.hidden = false;
    // Radio ids and names must stay unique next to the original.
    $$("input[type=radio]", clone).forEach(function (r, k) {
      var orig = $$("input[type=radio]", src)[k];
      r.id = r.id + "-lb"; r.name = r.name + "-lb"; r.checked = orig.checked;
    });
    $$("label[for]", clone).forEach(function (l) { l.htmlFor = l.htmlFor + "-lb"; });
    $$(".s-range", clone).forEach(function (r, k) { r.value = $$(".s-range", src)[k].value; });
    lbBody.replaceChildren(clone);
    if (view) pickTab(lbBody, view);
    lbBody.scrollTop = 0;
    var story = src.closest(".story");
    var title = $(".lb-title", lb);
    title.replaceChildren();
    var name = document.createElement("span");
    name.textContent = $("h2 .name", story).textContent;
    var path = document.createElement("span");
    path.className = "path";
    path.textContent = ($("h2 .path", story) || { textContent: "" }).textContent;
    title.append(name, path);
    $(".lb-pos", lb).textContent = (current + 1) + " / " + list.length;
    story.scrollIntoView({ block: "nearest" });
  }
  function open(entry) {
    view = null;
    list = visibleEntries();
    var i = list.indexOf(entry);
    if (i === -1) { list = [entry]; i = 0; }
    show(i);
    if (!lb.open) lb.showModal();
  }
  main.addEventListener("click", function (ev) {
    var t = ev.target;
    var trigger = t.closest(".expand") || (t.tagName === "IMG" && t.closest(".shot") && !t.closest(".slider") ? t : null);
    if (trigger) open(t.closest(".entry"));
  });
  $(".lb-prev", lb).addEventListener("click", function () { show(current - 1); });
  $(".lb-next", lb).addEventListener("click", function () { show(current + 1); });
  $(".lb-close", lb).addEventListener("click", function () { lb.close(); });
  lb.addEventListener("close", function () { lbBody.replaceChildren(); });
  lbBody.addEventListener("change", function (ev) {
    var m = /(?:^| )t-(\w+)/.exec(ev.target.className || "");
    if (m) view = m[1];
  });

  // Keyboard
  var storyCursor = -1;
  function pickTab(root, key) {
    var r = $("input.t-" + key, root);
    if (r) { r.checked = true; if (root === lbBody) view = key; return true; }
    return false;
  }
  document.addEventListener("keydown", function (ev) {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    var typing = ev.target.matches && ev.target.matches("input[type=search], input[type=text]");
    if (lb.open) {
      if (ev.key === "ArrowRight" || ev.key === "j") { show(current + 1); ev.preventDefault(); }
      else if (ev.key === "ArrowLeft" || ev.key === "k") { show(current - 1); ev.preventDefault(); }
      else if ({ s: "slider", g: "grid", b: "before", a: "after", d: "diff" }[ev.key]) {
        pickTab(lbBody, { s: "slider", g: "grid", b: "before", a: "after", d: "diff" }[ev.key]);
      } else if (ev.key === " ") {
        // Space flips between before and after in place.
        var after = $("input.t-after", lbBody);
        if (after) { pickTab(lbBody, after.checked ? "before" : "after"); ev.preventDefault(); }
      }
      return;
    }
    if (typing) {
      if (ev.key === "Escape") ev.target.blur();
      return;
    }
    if (ev.key === "/") { search.focus(); search.select(); ev.preventDefault(); }
    else if (ev.key === "j" || ev.key === "k") {
      var vis = stories.filter(function (s) { return !s.hidden && !s.closest("[hidden]") && (!s.closest("details") || s.closest("details").open); });
      if (!vis.length) return;
      var cur = vis.indexOf(stories[storyCursor]);
      cur = ev.key === "j" ? Math.min(cur + 1, vis.length - 1) : Math.max(cur - 1, 0);
      stories.forEach(function (s) { s.classList.remove("current"); });
      vis[cur].classList.add("current");
      storyCursor = stories.indexOf(vis[cur]);
      vis[cur].scrollIntoView({ block: "start" });
    } else if (ev.key === "Enter" || ev.key === "f") {
      var st = stories[storyCursor];
      var first = st && $$(".entry", st).filter(function (e) { return !e.hidden && $(".shot", e); })[0];
      if (first) { open(first); ev.preventDefault(); }
    }
  });

  readHash();
  if (search) search.value = state.q;
  apply();
})();
`;

/** The built-in report page. Exported so a custom template can wrap or reuse it. */
export function DefaultReport({ report, imagePrefix }: ReportTemplateProps) {
  const { summary, config } = report;
  const groups = groupByStory(report.results);
  const attention = groups.filter((g) => needsAttention(g.entries));
  const quiet = groups.filter((g) => !needsAttention(g.entries));

  const totals: Record<ReportStatus, number> = {
    pass: summary.passed,
    changed: summary.changed,
    new: summary.new,
    removed: summary.removed,
    "capture-failed": summary.captureFailed,
    updated: summary.updated,
  };
  const statuses = STATUS_ORDER.filter((s) => totals[s] > 0 || s === "pass" || s === "changed");

  // Modes as the run captured them; only offered as a filter when there is a choice.
  const modes = [...new Set(report.results.map((r) => r.mode).filter((m): m is string => m !== null))];

  const meta: string[] = [];
  if (report.commit) meta.push(`commit ${report.commit.slice(0, 7)}`);
  meta.push(`threshold ${config.threshold}`);
  if (config.maxDiffPixels > 0) meta.push(`up to ${config.maxDiffPixels} differing pixels tolerated`);
  if (config.clock) meta.push(`clock frozen at ${config.clock}`);
  meta.push(`generated ${report.generatedAt}`);

  const quietLabel = summary.updated > 0 ? "updated" : "passed";

  return (
    <html lang="en" className="no-js">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Snapshot report</title>
        {/* An empty icon, so the browser does not request /favicon.ico. */}
        <link rel="icon" href="data:," />
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        <header className="top">
          <div className="top-row">
            <h1>Snapshot report</h1>
            <p className="meta">{meta.join(" · ")}</p>
          </div>
          <div className="controls">
            {/* Plain counts without the script; filter toggles with it. */}
            <ul className="counts">
              {statuses.map((s) => (
                <li key={s}>
                  <span className={`chip no-js-chip ${totals[s] === 0 ? "zero" : s}`}>
                    {totals[s]} {STATUS_LABEL[s]}
                  </span>
                  <button type="button" className={`chip js-only ${s}`} data-status={s} aria-pressed="true">
                    <span className="dot" />
                    <span className="n">{totals[s]}</span> {STATUS_LABEL[s]}
                  </button>
                </li>
              ))}
            </ul>
            {modes.length > 1 && (
              <div className="seg js-only" role="group" aria-label="Mode">
                <button type="button" data-mode="" aria-pressed="true">
                  all modes
                </button>
                {modes.map((m) => (
                  <button key={m} type="button" data-mode={m} aria-pressed="false">
                    {m}
                  </button>
                ))}
              </div>
            )}
            <input type="search" className="search js-only" placeholder="Filter stories  ( / )" aria-label="Filter stories" />
            <span className="shown js-only" />
            <span className="hint js-only">
              <kbd>j</kbd>/<kbd>k</kbd> story · <kbd>f</kbd> full screen · alt-click a status to show only it
            </span>
          </div>
        </header>
        <main>
          {attention.map((group) => (
            <Story key={group.storyKey} group={group} prefix={imagePrefix} />
          ))}
          {quiet.length > 0 && (
            <details className="quiet">
              <summary>
                {quiet.length} {quietLabel} {quiet.length === 1 ? "story" : "stories"}
              </summary>
              {quiet.map((group) => (
                <Story key={group.storyKey} group={group} prefix={imagePrefix} />
              ))}
            </details>
          )}
          {groups.length === 0 && <p className="meta">No stories in this run.</p>}
        </main>
        <dialog className="lb js-only" aria-label="Full-screen view">
          <div className="lb-bar">
            <button type="button" className="lb-prev" aria-label="Previous">
              {"←"}
            </button>
            <button type="button" className="lb-next" aria-label="Next">
              {"→"}
            </button>
            <span className="lb-pos" />
            <span className="lb-title" />
            <span className="hint">
              <kbd>←</kbd>/<kbd>→</kbd> next · <kbd>space</kbd> flip before/after · <kbd>s</kbd> <kbd>g</kbd>{" "}
              <kbd>b</kbd> <kbd>a</kbd> <kbd>d</kbd> views · <kbd>esc</kbd> close
            </span>
            <button type="button" className="lb-close" aria-label="Close">
              {"✕"}
            </button>
          </div>
          <div className="lb-body" />
        </dialog>
        <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />
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
