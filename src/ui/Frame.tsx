import { Component, useEffect, useState, type ReactNode } from "react";
import type React from "react";
import { createRoot } from "react-dom/client";

type WrapperComponent = React.ComponentType<{ children: ReactNode }>;

export interface FrameProps {
  modules: Record<string, () => Promise<Record<string, unknown>>>;
  Wrapper: WrapperComponent;
  /** Per-package Wrappers of a multi-package project, keyed by package name. */
  wrappers?: Record<string, WrapperComponent>;
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="storybun-error">
          <div className="storybun-error-title">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5" />
              <path d="M7 4V8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <circle cx="7" cy="10.5" r="0.75" fill="currentColor" />
            </svg>
            Render error
          </div>
          <pre>{this.state.error.stack ?? this.state.error.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * The package a story belongs to: the longest package name its path starts
 * with. Undefined for a single-package project, which has no prefix.
 */
export function packageOf(storyKey: string, packages: string[]): string | undefined {
  const path = storyKey.split("--")[0] ?? "";
  let longest: string | undefined;
  for (const name of packages) {
    if ((path === name || path.startsWith(name + "/")) && (!longest || name.length > longest.length)) longest = name;
  }
  return longest;
}

type Loaded = { status: "loading" } | { status: "missing" } | { status: "ready"; Story: React.ComponentType };

/**
 * One story, alone in its document. The dev UI shows this page in an iframe,
 * so a story's global styles, portals and overlays stay inside the frame and
 * cannot cover or restyle the sidebar. The story key comes from `?story=`.
 */
function Frame({ modules, Wrapper, wrappers }: FrameProps) {
  const key = new URLSearchParams(location.search).get("story") ?? "";
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });

  useEffect(() => {
    const [path, exportName] = key.split("--");
    const loader = path ? modules[path] : undefined;
    if (!loader || !exportName) {
      setLoaded({ status: "missing" });
      return;
    }
    loader()
      .then((mod) => {
        const Story = mod[exportName];
        setLoaded(typeof Story === "function" ? { status: "ready", Story: Story as React.ComponentType } : { status: "missing" });
      })
      .catch((err) => {
        console.error("Failed to load story:", err);
        setLoaded({ status: "missing" });
      });
  }, [key, modules]);

  const pkg = wrappers ? packageOf(key, Object.keys(wrappers)) : undefined;
  const Active = (pkg ? wrappers?.[pkg] : undefined) ?? Wrapper;

  return (
    <Active>
      {loaded.status === "loading" && (
        <div className="storybun-loading">
          <div className="storybun-spinner" />
        </div>
      )}
      {loaded.status === "missing" && (
        <div className="storybun-empty">
          <div className="storybun-empty-text">Story not found</div>
          <div className="storybun-empty-hint">{key}</div>
        </div>
      )}
      {loaded.status === "ready" && (
        <ErrorBoundary>
          <loaded.Story />
        </ErrorBoundary>
      )}
    </Active>
  );
}

/**
 * Keys typed while the story has focus never reach the dev UI around it, so
 * the frame hands its few shortcuts up: ⌘K/ctrl+K (search), alt+↑/↓ (step
 * through stories) and r (reload), the last two only outside text fields.
 */
function forwardShortcuts() {
  if (window.parent === window) return;
  window.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
    const search = (e.metaKey || e.ctrlKey) && e.key === "k";
    const step = !typing && e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown");
    const reload = !typing && e.key === "r" && !e.metaKey && !e.ctrlKey && !e.altKey;
    if (!search && !step && !reload) return;
    e.preventDefault();
    window.parent.postMessage(
      { type: "storybun:key", key: e.key, altKey: e.altKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey },
      location.origin,
    );
  });
}

export function renderFrame(container: HTMLElement, props: FrameProps) {
  forwardShortcuts();
  createRoot(container).render(<Frame {...props} />);
}
