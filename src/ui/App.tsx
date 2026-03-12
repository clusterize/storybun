import { useState, useEffect, useCallback, Component, type ReactNode } from "react";
import type React from "react";
import type { StoryMeta } from "../types.ts";

interface Components {
  Layout: React.ComponentType<{ sidebar: ReactNode; children: ReactNode }>;
  Sidebar: React.ComponentType<{
    stories: StoryMeta[];
    active: string;
    onSelect: (key: string) => void;
  }>;
  Wrapper: React.ComponentType<{ children: ReactNode }>;
}

export interface AppProps {
  stories: StoryMeta[];
  modules: Record<string, () => Promise<Record<string, unknown>>>;
  components: Components;
  wrappers?: Record<string, React.ComponentType<{ children: ReactNode }>>;
}

// Error boundary
class ErrorBoundary extends Component<
  { children: ReactNode; storyKey: string },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prevProps: { storyKey: string }) {
    if (prevProps.storyKey !== this.props.storyKey) {
      this.setState({ error: null });
    }
  }

  render() {
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
          <pre>{this.state.error.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

function parseHash(): string {
  const hash = window.location.hash.slice(1);
  const params = new URLSearchParams(hash);
  return params.get("story") ?? "";
}

function setHash(storyKey: string) {
  window.location.hash = `story=${storyKey}`;
}

/**
 * Extract the package name from a story key like "@scope/pkg/Path--Export".
 * For single-package (no prefix in path), returns undefined.
 */
function extractPackageName(
  storyKey: string,
  wrappers: Record<string, React.ComponentType<{ children: ReactNode }>> | undefined,
): string | undefined {
  if (!wrappers || !storyKey) return undefined;
  const path = storyKey.split("--")[0];
  if (!path) return undefined;

  // Find the longest matching package name prefix
  let longest: string | undefined;
  for (const pkgName of Object.keys(wrappers)) {
    if (path === pkgName || path.startsWith(pkgName + "/")) {
      if (!longest || pkgName.length > longest.length) {
        longest = pkgName;
      }
    }
  }
  return longest;
}

const moduleCache = new Map<string, Record<string, unknown>>();

export function App({ stories, modules, components, wrappers }: AppProps) {
  const { Layout, Sidebar, Wrapper } = components;
  const [active, setActive] = useState(parseHash);
  const [StoryComponent, setStoryComponent] = useState<React.ComponentType | null>(null);
  const [loading, setLoading] = useState(false);

  const selectStory = useCallback((key: string) => {
    setHash(key);
    setActive(key);
  }, []);

  // Listen to hash changes
  useEffect(() => {
    const onHashChange = () => setActive(parseHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Load story module when active changes
  useEffect(() => {
    if (!active) {
      setStoryComponent(null);
      return;
    }

    const [path, exportName] = active.split("--");
    if (!path || !exportName) return;

    const loader = modules[path];
    if (!loader) return;

    const cached = moduleCache.get(path);
    if (cached) {
      const component = cached[exportName];
      setStoryComponent(
        typeof component === "function" ? () => component as React.ComponentType : null,
      );
      return;
    }

    setLoading(true);
    loader()
      .then((mod) => {
        moduleCache.set(path, mod);
        const component = mod[exportName];
        if (typeof component === "function") {
          setStoryComponent(() => component as React.ComponentType);
        } else {
          setStoryComponent(null);
        }
      })
      .catch((err) => {
        console.error("Failed to load story:", err);
        setStoryComponent(null);
      })
      .finally(() => setLoading(false));
  }, [active, modules]);

  // Resolve the active Wrapper: per-package if available, otherwise default
  const activePackage = extractPackageName(active, wrappers);
  const ActiveWrapper: React.ComponentType<{ children: ReactNode }> =
    (activePackage ? wrappers?.[activePackage] : undefined) ?? Wrapper;

  return (
    <Layout
      sidebar={
        <Sidebar stories={stories} active={active} onSelect={selectStory} />
      }
    >
      <ActiveWrapper>
        {!active && (
          <div className="storybun-empty">
            <svg className="storybun-empty-icon" width="48" height="48" viewBox="0 0 48 48" fill="none">
              <rect x="6" y="14" width="24" height="24" rx="4" stroke="currentColor" strokeWidth="1.5" />
              <rect x="18" y="10" width="24" height="24" rx="4" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
            </svg>
            <div className="storybun-empty-text">Select a story</div>
            <div className="storybun-empty-hint">
              Browse the sidebar or press <kbd>⌘K</kbd> to search
            </div>
          </div>
        )}
        {active && loading && (
          <div className="storybun-loading">
            <div className="storybun-spinner" />
          </div>
        )}
        {active && !loading && StoryComponent && (
          <ErrorBoundary storyKey={active}>
            <StoryComponent />
          </ErrorBoundary>
        )}
        {active && !loading && !StoryComponent && (
          <div className="storybun-empty">
            <div className="storybun-empty-text">Story not found</div>
          </div>
        )}
      </ActiveWrapper>
    </Layout>
  );
}
