import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import type { StoryMeta } from "../types.ts";

interface TreeNode {
  label: string;
  children: Map<string, TreeNode>;
  stories: { key: string; name: string }[];
}

function matchesFilter(story: { key: string; name: string }, filter: string): boolean {
  return story.name.toLowerCase().includes(filter) || story.key.toLowerCase().includes(filter);
}

function buildTree(stories: StoryMeta[]): TreeNode {
  const root: TreeNode = { label: "", children: new Map(), stories: [] };

  for (const story of stories) {
    const parts = story.path.split("/");
    let node = root;

    for (const part of parts) {
      if (!node.children.has(part)) {
        node.children.set(part, { label: part, children: new Map(), stories: [] });
      }
      node = node.children.get(part)!;
    }

    for (const exp of story.exports) {
      node.stories.push({
        key: `${story.path}--${exp}`,
        name: exp,
      });
    }
  }

  return root;
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`storybun-group-chevron${expanded ? " expanded" : ""}`}
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
    >
      <path
        d="M4.5 2.5L8 6L4.5 9.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TreeGroup({
  node,
  active,
  onSelect,
  filter,
}: {
  node: TreeNode;
  active: string;
  onSelect: (key: string) => void;
  filter: string;
}) {
  const [open, setOpen] = useState(true);

  const filteredStories = filter
    ? node.stories.filter((s) => matchesFilter(s, filter))
    : node.stories;

  const childEntries = [...node.children.entries()];
  const hasVisibleContent = filteredStories.length > 0 || childEntries.length > 0;

  if (filter && !hasVisibleContent) {
    // Check recursively if any children have matches
    const hasDeepMatch = childEntries.some(([, child]) => {
      const check = (n: TreeNode): boolean => {
        if (n.stories.some((s) => matchesFilter(s, filter))) return true;
        return [...n.children.values()].some(check);
      };
      return check(child);
    });
    if (!hasDeepMatch) return null;
  }

  // Single story, no children: render as a leaf item directly
  if (filteredStories.length === 1 && childEntries.length === 0) {
    const story = filteredStories[0];
    return (
      <button
        key={story.key}
        className={`storybun-story-item${active === story.key ? " active" : ""}`}
        onClick={() => onSelect(story.key)}
      >
        {node.label}
      </button>
    );
  }

  return (
    <div>
      <div
        className="storybun-group-label"
        onClick={() => setOpen(!open)}
      >
        <Chevron expanded={open} />
        {node.label}
      </div>
      {open && (
        <div className="storybun-group-children">
          {filteredStories.map((story) => (
            <button
              key={story.key}
              className={`storybun-story-item${active === story.key ? " active" : ""}`}
              onClick={() => onSelect(story.key)}
            >
              {story.name}
            </button>
          ))}
          {childEntries.map(([key, child]) => (
            <TreeGroup
              key={key}
              node={child}
              active={active}
              onSelect={onSelect}
              filter={filter}
            />
          ))}
        </div>
      )}
    </div>
  );
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
  const [filter, setFilter] = useState("");
  const tree = useMemo(() => buildTree(stories), [stories]);
  const normalizedFilter = filter.toLowerCase();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === "Escape" && document.activeElement === inputRef.current) {
        inputRef.current?.blur();
        setFilter("");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      <div className="storybun-sidebar-search">
        <svg
          className="storybun-search-icon"
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
        >
          <circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M8.5 8.5L12.5 12.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
        <input
          ref={inputRef}
          type="text"
          placeholder="Search stories..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {!filter && <kbd className="storybun-search-kbd">⌘K</kbd>}
        {filter && (
          <button
            className="storybun-search-clear"
            onClick={() => {
              setFilter("");
              inputRef.current?.focus();
            }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path
                d="M3 3L9 9M9 3L3 9"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
      </div>
      <div className="storybun-sidebar-tree">
        {[...tree.children.entries()].map(([key, node]) => (
          <TreeGroup
            key={key}
            node={node}
            active={active}
            onSelect={onSelect}
            filter={normalizedFilter}
          />
        ))}
      </div>
    </>
  );
}
