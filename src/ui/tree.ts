import type { StoryMeta } from "../types.ts";

export interface StoryLeaf {
  /** `<story path>--<export>`, the key the URL and the snapshot use. */
  key: string;
  /** The export name. */
  name: string;
  /** The story file's path, without the export. */
  path: string;
}

export interface TreeNode {
  /**
   * The full path up to and including this node, e.g. `pkg/components/button`.
   * Stable across renders, so it doubles as the key for the expanded set.
   */
  id: string;
  /** What the sidebar shows; several segments joined by `/` once compressed. */
  label: string;
  children: TreeNode[];
  stories: StoryLeaf[];
  /** Number of stories in this node and everything below it. */
  count: number;
}

/** Splits `a/b/File--Export` into the file path and the export name. */
export function splitKey(key: string): { path: string; name: string } {
  const at = key.lastIndexOf("--");
  return at === -1 ? { path: "", name: key } : { path: key.slice(0, at), name: key.slice(at + 2) };
}

export function storyLeaves(stories: StoryMeta[]): StoryLeaf[] {
  return stories.flatMap((s) => s.exports.map((name) => ({ key: `${s.path}--${name}`, name, path: s.path })));
}

/**
 * The sidebar tree: one node per path segment, stories hung on the node of
 * their file. Chains of nodes with a single child and no stories of their own
 * are folded into one row (`@scope/app/src`), since a level you can only
 * click through adds depth and nothing else.
 */
export function buildTree(stories: StoryMeta[]): TreeNode {
  const root: TreeNode = { id: "", label: "", children: [], stories: [], count: 0 };
  const index = new Map<string, TreeNode>([["", root]]);

  for (const story of stories) {
    let node = root;
    for (const part of story.path.split("/")) {
      const id = node.id ? `${node.id}/${part}` : part;
      let child = index.get(id);
      if (!child) {
        child = { id, label: part, children: [], stories: [], count: 0 };
        index.set(id, child);
        node.children.push(child);
      }
      node = child;
    }
    for (const name of story.exports) node.stories.push({ key: `${story.path}--${name}`, name, path: story.path });
  }

  const finish = (node: TreeNode): TreeNode => {
    node.children = node.children.map(finish);
    while (node !== root && node.stories.length === 0 && node.children.length === 1) {
      const only = node.children[0]!;
      node.id = only.id;
      node.label = `${node.label}/${only.label}`;
      node.children = only.children;
      node.stories = only.stories;
    }
    node.count = node.stories.length + node.children.reduce((n, c) => n + c.count, 0);
    return node;
  };
  return finish(root);
}

/** Ids of every node on the way to `key`, outermost first. */
export function ancestorIds(tree: TreeNode, key: string): string[] {
  const out: string[] = [];
  const walk = (node: TreeNode): boolean => {
    if (node.stories.some((s) => s.key === key)) return true;
    for (const child of node.children) {
      out.push(child.id);
      if (walk(child)) return true;
      out.pop();
    }
    return false;
  };
  return walk(tree) ? out : [];
}

/**
 * Stories matching every whitespace-separated term of `query`, anywhere in
 * the key, case-insensitively. Ranked so that what someone types first --
 * the component's name -- wins: export name starts with the query, then
 * export name contains it, then only the path does. Ties keep key order.
 */
export function searchStories(leaves: StoryLeaf[], query: string): StoryLeaf[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const whole = terms.join(" ");
  const scored: [number, number, StoryLeaf][] = [];
  leaves.forEach((leaf, i) => {
    const key = leaf.key.toLowerCase();
    if (!terms.every((t) => key.includes(t))) return;
    const name = leaf.name.toLowerCase();
    const score = name.startsWith(whole) ? 0 : terms.every((t) => name.includes(t)) ? 1 : 2;
    scored.push([score, i, leaf]);
  });
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return scored.map(([, , leaf]) => leaf);
}

export interface ExportNode {
  leaf: StoryLeaf;
  /** The export name, or only the part after its parent's name when nested. */
  label: string;
  children: ExportNode[];
}

/**
 * Nests the exports of one story file by name: an export goes under the
 * longest other export of the file its name starts with, at a word boundary
 * (`FileBrowserEmpty` under `FileBrowser`, shown as `Empty`). Exports
 * written as one per state of a component then read as that component and
 * its states. An export only nests under one that exists: two exports that
 * merely share a prefix stay side by side.
 */
export function nestExports(stories: StoryLeaf[]): ExportNode[] {
  const nodes = new Map(stories.map((leaf) => [leaf.name, { leaf, label: leaf.name, children: [] as ExportNode[] }]));
  const roots: ExportNode[] = [];
  for (const leaf of stories) {
    const node = nodes.get(leaf.name)!;
    let parent: ExportNode | undefined;
    for (const other of stories) {
      if (other.name.length >= leaf.name.length || !leaf.name.startsWith(other.name)) continue;
      // A word boundary: "ButtonGhost" nests under "Button", "Buttons" does not.
      if (!/[A-Z0-9_]/.test(leaf.name[other.name.length]!)) continue;
      if (!parent || other.name.length > parent.leaf.name.length) parent = nodes.get(other.name);
    }
    if (parent) {
      node.label = leaf.name.slice(parent.leaf.name.length).replace(/^_/, "");
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}
