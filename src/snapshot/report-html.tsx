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

/**
 * The page's sections, in order, each with the anchor the top bar links to.
 * The first four need a look and are open; the rest is folded away.
 */
const SECTIONS: { status: ReportStatus; id: string; title: string; folded: boolean }[] = [
  { status: "changed", id: "changed", title: "Changed", folded: false },
  { status: "new", id: "new", title: "New", folded: false },
  { status: "capture-failed", id: "capture-failed", title: "Capture failed", folded: false },
  { status: "removed", id: "removed", title: "Removed", folded: false },
  { status: "updated", id: "updated", title: "Updated", folded: true },
  { status: "pass", id: "passed", title: "Passed", folded: true },
];

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
}

function groupByStory(entries: ReportEntry[]): StoryGroup[] {
  const groups = new Map<string, ReportEntry[]>();
  for (const e of entries) {
    let list = groups.get(e.storyKey);
    if (!list) groups.set(e.storyKey, (list = []));
    list.push(e);
  }
  return [...groups.entries()].map(([storyKey, list]) => ({ storyKey, entries: list }));
}

/** `a/b/File--Export` → `["a/b/File", "Export"]`; a key without `--` is all name. */
function splitStoryKey(storyKey: string): [string, string] {
  const at = storyKey.lastIndexOf("--");
  return at === -1 ? ["", storyKey] : [storyKey.slice(0, at), storyKey.slice(at + 2)];
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
      <div className="shot">
        <Img src={`${prefix}${file}`} alt={caption} d={d} />
      </div>
    </figure>
  );
}

/**
 * Before and after in one box with a draggable divider: before shows left of
 * it, after right of it. Each image is clipped to its own side, so where one
 * is shorter than the other the box shows the empty checkerboard below it,
 * never the other image peeking through. Both are scaled by the same factor,
 * measured against the larger of the two, so a story that changed size stays
 * aligned at its top-left corner instead of being stretched to fit.
 */
function Slider({ entry, prefix }: { entry: ReportEntry; prefix: string }) {
  const { files, dimensions } = entry;
  const b = dimensions.baseline;
  const a = dimensions.actual;
  const box = b && a ? { width: Math.max(b.width, a.width), height: Math.max(b.height, a.height) } : (a ?? b);
  const pct = (d: ReportDimensions | null) => (d && box ? `${(d.width / box.width) * 100}%` : "100%");
  return (
    <div className="shot">
      <div
        className={box ? "slider" : "slider no-box"}
        style={{
          ["--pos" as string]: "50%",
          aspectRatio: box ? `${box.width} / ${box.height}` : undefined,
          maxWidth: box ? `${box.width}px` : undefined,
        }}
      >
        <div className="s-side s-before">
          <img src={`${prefix}${files.baseline}`} alt="before" loading="lazy" style={{ width: pct(b) }} />
        </div>
        <div className="s-side s-after">
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
              <div className="shot">
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
          <button type="button" className="expand js-only" title="Full screen (or click the image)" aria-label="Full screen">
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

function Story({ group, prefix, id }: { group: StoryGroup; prefix: string; id: string }) {
  const [path, name] = splitStoryKey(group.storyKey);
  return (
    <article className="story" id={id} data-key={group.storyKey.toLowerCase()}>
      <h3>
        <a href={`#${id}`} className="anchor">
          <span className="name">{name}</span>
          {path && <span className="path">{path}</span>}
        </a>
        {/* The full key, unsplit, for searching the page and for copying. */}
        <span className="key">{group.storyKey}</span>
      </h3>
      <div className="entries">
        {group.entries.map((entry, i) => (
          <Entry key={i} uid={`${id}-e${i}`} entry={entry} prefix={prefix} />
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
html { scroll-padding-top: 112px; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
.no-js .js-only { display: none !important; }
button { font: inherit; color: inherit; }
a { color: inherit; }

/* Top bar */
.top { position: sticky; top: 0; z-index: 10; background: var(--bar); backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--line); padding: 12px 24px; }
.top-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
h1 { font-size: 17px; margin: 0; }
.meta { color: var(--muted); margin: 0; font-size: 12px; }
.controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin-top: 10px; }
.counts { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 12px;
  background: var(--card); border: 1px solid var(--line); text-decoration: none; }
a.chip:hover { border-color: var(--muted); }
.chip.zero { color: var(--muted); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.chip.changed .dot { background: var(--changed); } .chip.new .dot { background: var(--new); }
.chip.removed .dot { background: var(--removed); } .chip.capture-failed .dot { background: var(--failed); }
.chip.pass .dot, .chip.updated .dot { background: var(--pass); }
.chip.zero .dot { background: transparent; box-shadow: inset 0 0 0 1.5px var(--muted); }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.seg button { border: 0; background: none; padding: 3px 12px; cursor: pointer; color: var(--muted); }
.seg button + button { border-left: 1px solid var(--line); }
.seg button[aria-pressed="true"] { background: var(--fg); color: var(--bg); }
.search { padding: 4px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg);
  color: var(--fg); font: inherit; min-width: 220px; flex: 0 1 320px; }
.hint { color: var(--muted); font-size: 12px; margin-left: auto; }
kbd { font: 11px ui-monospace, monospace; border: 1px solid var(--line); border-bottom-width: 2px;
  border-radius: 4px; padding: 0 4px; }
button:focus-visible, input:focus-visible, a:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

/* Sections and stories */
main { padding: 0 24px 64px; }
.status-section { padding-top: 8px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .05em; margin: 16px 0 0; padding-bottom: 6px;
  border-bottom: 2px solid var(--line); display: flex; align-items: baseline; gap: 8px; }
h2 .n { color: var(--muted); font-weight: 400; }
#changed h2 { border-color: var(--changed); } #new h2 { border-color: var(--new); }
#capture-failed h2 { border-color: var(--failed); } #removed h2 { border-color: var(--removed); }
details.folded > summary { cursor: pointer; list-style: none; }
details.folded > summary::-webkit-details-marker { display: none; }
details.folded > summary h2::before { content: "▸"; color: var(--muted); }
details.folded[open] > summary h2::before { content: "▾"; }
.story { border-bottom: 1px solid var(--line); padding: 16px 0; }
.story.current > h3 .name { text-decoration: underline; text-decoration-color: var(--focus); text-underline-offset: 4px; }
h3 { font-size: 15px; margin: 0 0 8px; font-weight: 600; display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; }
h3 .anchor { text-decoration: none; display: contents; }
h3 .path { color: var(--muted); font-weight: 400; font-size: 12px; word-break: break-all; }
h3 .key { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.entries { display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr); }
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

/* Before/after slider: each side clipped to its half of the divider */
.slider { position: relative; width: 100%; border: 1px solid var(--line); overflow: hidden;
  background: repeating-conic-gradient(var(--line) 0 25%, transparent 0 50%) 0 0 / 16px 16px; }
.s-side { position: absolute; inset: 0; }
.s-before { clip-path: inset(0 calc(100% - var(--pos)) 0 0); }
.s-after { clip-path: inset(0 0 0 var(--pos)); }
.slider img { position: absolute; top: 0; left: 0; max-width: none; height: auto; border: 0; background: none; }
.slider::after { content: ""; position: absolute; top: 0; bottom: 0; left: var(--pos); width: 2px;
  margin-left: -1px; background: var(--focus); box-shadow: 0 0 0 1px rgba(0,0,0,.25); pointer-events: none; }
/* Sizes unknown (a PNG header could not be read): the before image gives the box its height. */
.slider.no-box .s-before, .slider.no-box .s-before img { position: relative; }
.s-range { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: ew-resize; }
.s-tag { position: absolute; top: 6px; font-size: 11px; padding: 0 6px; border-radius: 4px;
  background: rgba(0,0,0,.6); color: #fff; pointer-events: none; }
.s-tag-before { left: 6px; } .s-tag-after { right: 6px; }
.no-js .s-range { display: none; }

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
.lb-bar .hint { white-space: nowrap; }
.lb-bar button { border: 1px solid var(--line); background: var(--card); border-radius: 6px; padding: 2px 10px; cursor: pointer; }
.lb-body { flex: 1; overflow: auto; padding: 16px; }
.lb-body .entry { background: none; padding: 0; }
.lb-body .entry-head .expand { display: none; }
.lb-body .shot img { cursor: default; }
.lb-body .images.cols-1 img, .lb-body .single img { margin: 0 auto; }
.lb-body .slider { margin: 0 auto; }
@media (max-width: 720px) {
  .top, main { padding-left: 16px; padding-right: 16px; }
  .hint { display: none; }
}
`;

/**
 * The page script. Everything it adds sits on top of a page that already
 * works without it: the mode switch, the story filter, the slider's divider,
 * the full-screen view and the keyboard shortcuts. It reads only the DOM,
 * never report data, so nothing from a story key can end up in it.
 *
 * The URL fragment is left to the section and story anchors; the mode goes
 * in the query string (`?mode=dark`), so a shared link keeps both.
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
  var sections = $$("main .status-section");
  var modeButtons = $$(".seg button[data-mode]");
  var modes = modeButtons.map(function (b) { return b.dataset.mode; });
  var search = $(".search");

  var params = new URLSearchParams(location.search);
  var mode = "";
  if (modes.length) {
    var stored = null;
    try { stored = localStorage.getItem("storybun-report-mode"); } catch (e) {}
    mode = [params.get("mode"), stored, modes[0]].filter(function (m) { return m && modes.indexOf(m) !== -1; })[0];
  }
  var q = "";

  function apply() {
    var terms = q.trim().toLowerCase().split(/\\s+/).filter(Boolean);
    stories.forEach(function (story) {
      var key = story.dataset.key;
      var matches = terms.every(function (t) { return key.indexOf(t) !== -1; });
      var any = false;
      $$(".entry", story).forEach(function (e) {
        var show = matches && (!mode || e.dataset.mode === mode);
        e.hidden = !show;
        any = any || show;
      });
      story.hidden = !any;
    });
    sections.forEach(function (section) {
      var n = $$(".entry", section).filter(function (e) { return !e.hidden; }).length;
      $("h2 .n", section).textContent = n;
      var link = $('.counts a[href="#' + section.id + '"]');
      if (link) {
        $(".n", link).textContent = n;
        link.classList.toggle("zero", n === 0);
      }
      section.hidden = n === 0;
    });
    modeButtons.forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.mode === mode)); });
    if (mode) {
      params.set("mode", mode);
      history.replaceState(null, "", "?" + params.toString() + location.hash);
      try { localStorage.setItem("storybun-report-mode", mode); } catch (e) {}
    }
  }

  modeButtons.forEach(function (b) {
    b.addEventListener("click", function () { mode = b.dataset.mode; apply(); });
  });
  if (search) search.addEventListener("input", function () { q = search.value; apply(); });

  // A link into a folded section opens it.
  function openTarget() {
    var t = location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)));
    var d = t && (t.tagName === "DETAILS" ? t : t.closest("details"));
    if (d && !d.open) { d.open = true; t.scrollIntoView(); }
  }
  window.addEventListener("hashchange", openTarget);

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
  var list = [];
  function pickTab(root, key) {
    var r = $("input.t-" + key, root);
    if (r) { r.checked = true; if (root === lbBody) view = key; return true; }
    return false;
  }
  function visibleEntries() {
    return entries.filter(function (e) {
      var d = e.closest("details");
      return !e.closest("[hidden]") && (!d || d.open) && $(".shot", e);
    });
  }
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
    name.textContent = $("h3 .name", story).textContent;
    var path = document.createElement("span");
    path.className = "path";
    path.textContent = ($("h3 .path", story) || { textContent: "" }).textContent;
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
    var m = /(?:^| )t-(\\w+)/.exec(ev.target.className || "");
    if (m) view = m[1];
  });

  // Keyboard
  var storyCursor = -1;
  var VIEWS = { s: "slider", g: "grid", b: "before", a: "after", d: "diff" };
  document.addEventListener("keydown", function (ev) {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    var typing = ev.target.matches && ev.target.matches("input[type=search], input[type=text]");
    if (lb.open) {
      if (ev.key === "ArrowRight" || ev.key === "j") { show(current + 1); ev.preventDefault(); }
      else if (ev.key === "ArrowLeft" || ev.key === "k") { show(current - 1); ev.preventDefault(); }
      else if (VIEWS[ev.key]) pickTab(lbBody, VIEWS[ev.key]);
      else if (ev.key === " ") {
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
    else if (ev.key === "m" && modes.length > 1) {
      mode = modes[(modes.indexOf(mode) + 1) % modes.length];
      apply();
    } else if (ev.key === "j" || ev.key === "k") {
      var vis = stories.filter(function (s) {
        var d = s.closest("details");
        return !s.closest("[hidden]") && (!d || d.open);
      });
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

  apply();
  openTarget();
})();
`;

/** The built-in report page. Exported so a custom template can wrap or reuse it. */
export function DefaultReport({ report, imagePrefix }: ReportTemplateProps) {
  const { config } = report;

  // Modes in config order; one is shown at a time once the script runs.
  const seen = new Set(report.results.map((r) => r.mode).filter((m): m is string => m !== null));
  const modes = [...config.modes.filter((m) => seen.has(m)), ...[...seen].filter((m) => !config.modes.includes(m))];

  const sections = SECTIONS.map((s) => {
    const entries = report.results.filter((r) => r.status === s.status);
    return { ...s, entries, groups: groupByStory(entries) };
  }).filter((s) => s.entries.length > 0 || s.status === "changed");

  const meta: string[] = [];
  if (report.commit) meta.push(`commit ${report.commit.slice(0, 7)}`);
  meta.push(`threshold ${config.threshold}`);
  if (config.maxDiffPixels > 0) meta.push(`up to ${config.maxDiffPixels} differing pixels tolerated`);
  if (config.clock) meta.push(`clock frozen at ${config.clock}`);
  meta.push(`generated ${report.generatedAt}`);

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
          <nav className="controls" aria-label="Report">
            <ul className="counts">
              {sections.map((s) => (
                <li key={s.id}>
                  <a href={`#${s.id}`} className={`chip ${s.entries.length === 0 ? "zero" : s.status}`}>
                    <span className="dot" />
                    <span className="n">{s.entries.length}</span> {STATUS_LABEL[s.status]}
                  </a>
                </li>
              ))}
            </ul>
            {modes.length > 1 && (
              <div className="seg js-only" role="group" aria-label="Mode">
                {modes.map((m, i) => (
                  <button key={m} type="button" data-mode={m} aria-pressed={i === 0 ? "true" : "false"}>
                    {m}
                  </button>
                ))}
              </div>
            )}
            <input type="search" className="search js-only" placeholder="Filter stories  ( / )" aria-label="Filter stories" />
            <span className="hint js-only">
              <kbd>j</kbd>/<kbd>k</kbd> story · <kbd>f</kbd> full screen{modes.length > 1 ? " · " : ""}
              {modes.length > 1 && (
                <>
                  <kbd>m</kbd> mode
                </>
              )}
            </span>
          </nav>
        </header>
        <main>
          {sections.map((s) => {
            const heading = (
              <h2>
                {s.title} <span className="n">{s.entries.length}</span>
              </h2>
            );
            const body =
              s.groups.length > 0 ? (
                s.groups.map((group, i) => (
                  <Story key={group.storyKey} group={group} prefix={imagePrefix} id={`${s.id}-${i}`} />
                ))
              ) : (
                <p className="meta">Nothing {STATUS_LABEL[s.status]}.</p>
              );
            return s.folded ? (
              <details key={s.id} id={s.id} className="status-section folded">
                <summary>{heading}</summary>
                {body}
              </details>
            ) : (
              <section key={s.id} id={s.id} className="status-section">
                {heading}
                {body}
              </section>
            );
          })}
          {report.results.length === 0 && <p className="meta">No stories in this run.</p>}
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
