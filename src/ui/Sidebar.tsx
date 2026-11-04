import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import type { StoryMeta } from "../types.ts";
import { ancestorIds, buildTree, searchStories, storyLeaves, type StoryLeaf, type TreeNode } from "./tree.ts";
import { readStored, writeStored } from "./storage.ts";

/** Search results beyond this are not rendered; the count still says how many matched. */
const MAX_RESULTS = 200;
const EXPANDED_KEY = "storybun:expanded";

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg className={`storybun-group-chevron${expanded ? " expanded" : ""}`} width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M4.5 2.5L8 6L4.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StoryButton({
  leaf,
  label,
  active,
  onSelect,
  detail,
}: {
  leaf: StoryLeaf;
  label: string;
  active: boolean;
  onSelect: (key: string) => void;
  detail?: string;
}) {
  return (
    <button
      className={`storybun-story-item${active ? " active" : ""}`}
      onClick={() => onSelect(leaf.key)}
      title={leaf.key}
      data-story-key={leaf.key}
      aria-current={active ? "page" : undefined}
    >
      <span className="storybun-story-name">{label}</span>
      {detail && <span className="storybun-story-path">{"\u200E" + detail}</span>}
    </button>
  );
}

function TreeGroup({
  node,
  active,
  expanded,
  onToggle,
  onSelect,
}: {
  node: TreeNode;
  active: string;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onSelect: (key: string) => void;
}) {
  // A file with one story is one row, named after the file.
  if (node.children.length === 0 && node.stories.length === 1) {
    const leaf = node.stories[0]!;
    return <StoryButton leaf={leaf} label={node.label} active={active === leaf.key} onSelect={onSelect} />;
  }

  const open = expanded.has(node.id);
  return (
    <div className="storybun-group">
      <button className="storybun-group-label" onClick={() => onToggle(node.id)} aria-expanded={open} title={node.id}>
        <Chevron expanded={open} />
        <span className="storybun-group-name">{node.label}</span>
        <span className="storybun-group-count">{node.count}</span>
      </button>
      {open && (
        <div className="storybun-group-children">
          {node.stories.map((leaf) => (
            <StoryButton key={leaf.key} leaf={leaf} label={leaf.name} active={active === leaf.key} onSelect={onSelect} />
          ))}
          {node.children.map((child) => (
            <TreeGroup key={child.id} node={child} active={active} expanded={expanded} onToggle={onToggle} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The last two segments of a story file's path, enough to tell same-named exports apart. */
function shortPath(path: string): string {
  return path.split("/").slice(-2).join("/");
}

export function Sidebar({
  stories,
  active,
  onSelect,
}: {
  stories: StoryMeta[];
  active: string;
  onSelect: (key: string) => void;
}) {
  const tree = useMemo(() => buildTree(stories), [stories]);
  const leaves = useMemo(() => storyLeaves(stories), [stories]);
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(readStored<string[]>(EXPANDED_KEY, [])));
  const inputRef = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => searchStories(leaves, filter), [leaves, filter]);
  const searching = filter.trim() !== "";

  useEffect(() => writeStored(EXPANDED_KEY, [...expanded]), [expanded]);

  // Open the way to the active story, then bring it into view.
  useEffect(() => {
    if (!active) return;
    const ids = ancestorIds(tree, active);
    setExpanded((prev) => (ids.every((id) => prev.has(id)) ? prev : new Set([...prev, ...ids])));
  }, [active, tree]);
  useEffect(() => {
    if (searching || !active) return;
    const el = treeRef.current?.querySelector(`[data-story-key="${CSS.escape(active)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, expanded, searching]);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const collapseAll = () => setExpanded(new Set(active ? ancestorIds(tree, active) : []));

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => setCursor(0), [filter]);
  useEffect(() => {
    treeRef.current?.querySelector(".storybun-result.cursor")?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setFilter("");
      inputRef.current?.blur();
    } else if (searching && e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, Math.min(results.length, MAX_RESULTS) - 1));
    } else if (searching && e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (searching && e.key === "Enter") {
      const leaf = results[cursor];
      if (leaf) onSelect(leaf.key);
    }
  };

  return (
    <>
      <div className="storybun-sidebar-search">
        <svg className="storybun-search-icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
          <circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8.5 8.5L12.5 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          placeholder={`Search ${leaves.length} stories…`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={onInputKey}
          aria-label="Search stories"
        />
        {!filter && <kbd className="storybun-search-kbd">⌘K</kbd>}
        {filter && (
          <button
            className="storybun-search-clear"
            aria-label="Clear search"
            onClick={() => {
              setFilter("");
              inputRef.current?.focus();
            }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
      <div className="storybun-sidebar-meta">
        {searching ? (
          <span>
            {results.length} {results.length === 1 ? "match" : "matches"}
            {results.length > 0 && " · ↑↓ to pick, ↵ to open"}
          </span>
        ) : (
          <>
            <span>{leaves.length} stories</span>
            <button className="storybun-link" onClick={collapseAll}>
              collapse all
            </button>
          </>
        )}
      </div>
      <div className="storybun-sidebar-tree" ref={treeRef}>
        {searching ? (
          <>
            {results.slice(0, MAX_RESULTS).map((leaf, i) => (
              <div key={leaf.key} className={i === cursor ? "storybun-result cursor" : "storybun-result"}>
                <StoryButton
                  leaf={leaf}
                  label={leaf.name}
                  detail={shortPath(leaf.path)}
                  active={active === leaf.key}
                  onSelect={onSelect}
                />
              </div>
            ))}
            {results.length > MAX_RESULTS && (
              <div className="storybun-sidebar-note">{results.length - MAX_RESULTS} more, refine the search</div>
            )}
            {results.length === 0 && <div className="storybun-sidebar-note">No story matches “{filter.trim()}”.</div>}
          </>
        ) : (
          tree.children.map((node) => (
            <TreeGroup key={node.id} node={node} active={active} expanded={expanded} onToggle={toggle} onSelect={onSelect} />
          ))
        )}
      </div>
    </>
  );
}
