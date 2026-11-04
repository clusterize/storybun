import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type React from "react";
import type { SnapshotMode, StoryMeta } from "../types.ts";
import { readStored, writeStored } from "./storage.ts";
import { splitKey, storyLeaves } from "./tree.ts";

interface Components {
  Layout: React.ComponentType<{ sidebar: ReactNode; children: ReactNode }>;
  Sidebar: React.ComponentType<{
    stories: StoryMeta[];
    active: string;
    onSelect: (key: string) => void;
  }>;
}

export interface Viewport {
  width: number;
  height: number;
  name?: string;
}

export interface AppProps {
  stories: StoryMeta[];
  components: Components;
  /** `snapshot.modes`: offered in the toolbar, so the canvas shows what a baseline shows. */
  modes?: Record<string, SnapshotMode>;
  /** `snapshot.viewports`, offered next to a few common sizes. */
  viewports?: Viewport[];
  /** Where the story frame page is served. */
  frameUrl?: string;
}

/** Not a mode: the browser's own `prefers-color-scheme`, nothing emulated. */
const SYSTEM = "";
const FILL = "fill";

const PRESETS: Viewport[] = [
  { width: 375, height: 667, name: "phone" },
  { width: 768, height: 1024, name: "tablet" },
];

interface ViewState {
  story: string;
  mode: string;
  viewport: string;
  /** Show every mode side by side instead of one. */
  compare: boolean;
}

function readHash(fallback: ViewState): ViewState {
  const p = new URLSearchParams(window.location.hash.slice(1));
  return {
    story: p.get("story") ?? "",
    mode: p.has("mode") ? p.get("mode")! : fallback.mode,
    viewport: p.get("viewport") ?? fallback.viewport,
    compare: p.has("compare") ? p.get("compare") === "1" : fallback.compare,
  };
}

function writeHash(state: ViewState) {
  const p = new URLSearchParams();
  if (state.story) p.set("story", state.story);
  p.set("mode", state.mode);
  p.set("viewport", state.viewport);
  if (state.compare) p.set("compare", "1");
  // Story keys are mostly path characters; keep them readable in the URL.
  const hash = "#" + p.toString().replace(/%2F/g, "/").replace(/%40/g, "@");
  if (hash !== window.location.hash) window.history.replaceState(null, "", hash);
}

function viewportKey(v: Viewport): string {
  return `${v.width}x${v.height}`;
}

function parseViewport(key: string): Viewport | null {
  const m = /^(\d+)x(\d+)$/.exec(key);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

function frameSrc(frameUrl: string, story: string, colorScheme: string | undefined, nonce: number): string {
  const p = new URLSearchParams({ story });
  if (colorScheme) p.set("colorScheme", colorScheme);
  if (nonce) p.set("reload", String(nonce));
  return `${frameUrl}?${p}`;
}

function Icon({ d }: { d: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d={d} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Toolbar({
  story,
  state,
  modes,
  viewports,
  onChange,
  onReload,
  frameHref,
}: {
  story: string;
  state: ViewState;
  modes: string[];
  viewports: Viewport[];
  onChange: (patch: Partial<ViewState>) => void;
  onReload: () => void;
  frameHref: string;
}) {
  const { path, name } = splitKey(story);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(story).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div className="storybun-toolbar">
      <div className="storybun-toolbar-title" title={story}>
        <span className="storybun-toolbar-name">{name}</span>
        {/* The path is cut from the left (rtl); the leading LRM keeps a
            leading "@" or "." from being moved to the end by the bidi rules. */}
        <span className="storybun-toolbar-path">{"\u200E" + path}</span>
      </div>
      <div className="storybun-toolbar-actions">
        {modes.length > 0 && (
          <div className="storybun-seg" role="group" aria-label="Mode">
            {modes.map((m) => (
              <button
                key={m}
                aria-pressed={!state.compare && state.mode === m}
                onClick={() => onChange({ mode: m, compare: false })}
              >
                {m}
              </button>
            ))}
            {modes.length > 1 && (
              <button aria-pressed={state.compare} onClick={() => onChange({ compare: !state.compare })} title="All modes side by side">
                side by side
              </button>
            )}
          </div>
        )}
        <select
          className="storybun-select"
          aria-label="Viewport"
          value={state.viewport}
          onChange={(e) => onChange({ viewport: e.target.value })}
        >
          <option value={FILL}>fill</option>
          {viewports.map((v) => (
            <option key={viewportKey(v)} value={viewportKey(v)}>
              {v.name ? `${v.name} · ` : ""}
              {v.width}×{v.height}
            </option>
          ))}
        </select>
        <button className="storybun-icon-button" onClick={copy} title="Copy story key">
          {copied ? <Icon d="M3 7.5 6 10.5 11 4" /> : <Icon d="M5 5V2.5h6.5V9H9M2.5 5H9v6.5H2.5z" />}
        </button>
        <button className="storybun-icon-button" onClick={onReload} title="Reload story (r)">
          <Icon d="M11.5 7A4.5 4.5 0 1 1 10 3.6M11.5 1.5v3h-3" />
        </button>
        <a className="storybun-icon-button" href={frameHref} target="_blank" rel="noreferrer" title="Open story alone in a new tab">
          <Icon d="M8 2.5h3.5V6M11.5 2.5 6.5 7.5M10 8.5v3H2.5V4h3" />
        </a>
      </div>
    </div>
  );
}

function Canvas({
  frames,
  viewport,
}: {
  frames: { label: string | null; src: string }[];
  viewport: Viewport | null;
}) {
  return (
    <div className={`storybun-canvas${viewport ? " fixed" : ""}${frames.length > 1 ? " multi" : ""}`}>
      {frames.map((f) => (
        <div key={f.label ?? "single"} className="storybun-frame-cell">
          {f.label !== null && <div className="storybun-frame-label">{f.label}</div>}
          <iframe
            key={f.src}
            className="storybun-frame"
            src={f.src}
            title={f.label ?? "Story"}
            style={viewport ? { width: viewport.width, height: viewport.height } : undefined}
          />
        </div>
      ))}
    </div>
  );
}

const PREFS_KEY = "storybun:view";

export function App({ stories, components, modes = {}, viewports = [], frameUrl = "/frame.html" }: AppProps) {
  const { Layout, Sidebar } = components;
  const modeNames = Object.keys(modes);
  const leaves = useMemo(() => storyLeaves(stories), [stories]);

  // What a URL without a view part falls back to: the last view used here.
  const defaults = useMemo<ViewState>(() => {
    const stored = readStored<Partial<ViewState>>(PREFS_KEY, {});
    const mode = stored.mode !== undefined && (stored.mode === SYSTEM || stored.mode in modes) ? stored.mode : (modeNames[0] ?? SYSTEM);
    return { story: "", mode, viewport: stored.viewport ?? FILL, compare: stored.compare ?? false };
  }, []);

  const [state, setState] = useState<ViewState>(() => readHash(defaults));
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    writeHash(state);
    writeStored(PREFS_KEY, { mode: state.mode, viewport: state.viewport, compare: state.compare });
  }, [state]);

  useEffect(() => {
    const onHashChange = () => setState(readHash(defaults));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [defaults]);

  const update = useCallback((patch: Partial<ViewState>) => setState((s) => ({ ...s, ...patch })), []);
  const selectStory = useCallback((story: string) => update({ story }), [update]);

  // alt+↑/↓: previous/next story in sidebar order; r: reload the story.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        setState((s) => {
          const i = leaves.findIndex((l) => l.key === s.story);
          const next = leaves[Math.min(Math.max(i + (e.key === "ArrowDown" ? 1 : -1), 0), leaves.length - 1)];
          return next ? { ...s, story: next.key } : s;
        });
      } else if (e.key === "r" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        setNonce((n) => n + 1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [leaves]);

  // Shortcuts typed inside the story frame arrive as messages; replay them here.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.data?.type !== "storybun:key") return;
      const { key, altKey, metaKey, ctrlKey } = e.data;
      window.dispatchEvent(new KeyboardEvent("keydown", { key, altKey, metaKey, ctrlKey }));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    const { name } = splitKey(state.story);
    document.title = state.story ? `${name} · storybun` : "storybun";
  }, [state.story]);

  const allViewports = useMemo(() => {
    const seen = new Set<string>();
    return [...viewports, ...PRESETS].filter((v) => {
      const k = viewportKey(v);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [viewports]);

  const known = leaves.some((l) => l.key === state.story);
  const shownModes = state.compare && modeNames.length > 1 ? modeNames : [state.mode];
  const frames = shownModes.map((m) => ({
    label: shownModes.length > 1 ? m : null,
    src: frameSrc(frameUrl, state.story, modes[m]?.colorScheme, nonce),
  }));

  return (
    <Layout sidebar={<Sidebar stories={stories} active={state.story} onSelect={selectStory} />}>
      {state.story && known ? (
        <>
          <Toolbar
            story={state.story}
            state={state}
            modes={modeNames}
            viewports={allViewports}
            onChange={update}
            onReload={() => setNonce((n) => n + 1)}
            frameHref={frames[0]!.src}
          />
          <Canvas frames={frames} viewport={parseViewport(state.viewport)} />
        </>
      ) : (
        <div className="storybun-empty storybun-empty-page">
          <svg className="storybun-empty-icon" width="48" height="48" viewBox="0 0 48 48" fill="none">
            <rect x="6" y="14" width="24" height="24" rx="4" stroke="currentColor" strokeWidth="1.5" />
            <rect x="18" y="10" width="24" height="24" rx="4" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
          </svg>
          <div className="storybun-empty-text">{state.story ? "Story not found" : "Select a story"}</div>
          <div className="storybun-empty-hint">
            Browse the sidebar or press <kbd>⌘K</kbd> to search · <kbd>⌥↑</kbd> <kbd>⌥↓</kbd> step through stories
          </div>
        </div>
      )}
    </Layout>
  );
}
