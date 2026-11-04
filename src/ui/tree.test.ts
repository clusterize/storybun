import { describe, expect, test } from "bun:test";
import { ancestorIds, buildTree, nestExports, searchStories, splitKey, storyLeaves } from "./tree.ts";

const stories = [
  { path: "@acme/app/src/features/billing/invoice-list", exports: ["InvoiceList", "InvoiceListEmpty"] },
  { path: "@acme/app/src/features/billing/invoice-row", exports: ["InvoiceRow"] },
  { path: "@acme/app/src/features/users/user-card", exports: ["UserCard"] },
  { path: "@acme/ui/button", exports: ["Button", "ButtonGhost"] },
];

describe("buildTree", () => {
  test("folds single-child chains into one row and counts stories per node", () => {
    const tree = buildTree(stories);
    expect(tree.count).toBe(6);
    expect(tree.children.map((c) => c.label)).toEqual(["@acme"]);
    const acme = tree.children[0]!;
    // "@acme" has two children (app, ui), so it is not folded further.
    expect(acme.children.map((c) => [c.label, c.count])).toEqual([
      ["app/src/features", 4],
      ["ui/button", 2],
    ]);
    const features = acme.children[0]!;
    expect(features.id).toBe("@acme/app/src/features");
    expect(features.children.map((c) => c.label)).toEqual(["billing", "users/user-card"]);
  });

  test("a folded file node keeps its stories", () => {
    const button = buildTree(stories).children[0]!.children[1]!;
    expect(button.stories.map((s) => s.key)).toEqual(["@acme/ui/button--Button", "@acme/ui/button--ButtonGhost"]);
    expect(button.children).toEqual([]);
  });

  test("a single top-level chain is folded too", () => {
    const tree = buildTree([{ path: "src/components/badge", exports: ["Badge"] }]);
    expect(tree.children.map((c) => c.label)).toEqual(["src/components/badge"]);
  });
});

describe("ancestorIds", () => {
  test("lists the nodes to open for a story, outermost first", () => {
    const tree = buildTree(stories);
    expect(ancestorIds(tree, "@acme/app/src/features/billing/invoice-row--InvoiceRow")).toEqual([
      "@acme",
      "@acme/app/src/features",
      "@acme/app/src/features/billing",
      "@acme/app/src/features/billing/invoice-row",
    ]);
  });

  test("is empty for an unknown key", () => {
    expect(ancestorIds(buildTree(stories), "nope--Nope")).toEqual([]);
  });
});

describe("searchStories", () => {
  const leaves = storyLeaves(stories);

  test("matches every term anywhere in the key and returns stories only, no empty groups", () => {
    expect(searchStories(leaves, "billing empty").map((l) => l.key)).toEqual([
      "@acme/app/src/features/billing/invoice-list--InvoiceListEmpty",
    ]);
  });

  test("ranks name-prefix matches over name matches over path matches", () => {
    const keys = searchStories(leaves, "invoice").map((l) => l.name);
    expect(keys).toEqual(["InvoiceList", "InvoiceListEmpty", "InvoiceRow"]);
    expect(searchStories(leaves, "button").map((l) => l.name)).toEqual(["Button", "ButtonGhost"]);
    expect(searchStories(leaves, "ghost").map((l) => l.name)).toEqual(["ButtonGhost"]);
    // Key order is Helper, ArrowIcon, RowHeader; the ranking reverses it.
    const ranked = storyLeaves([
      { path: "a/row-utils", exports: ["Helper"] },
      { path: "b/icons", exports: ["ArrowIcon"] },
      { path: "c/table", exports: ["RowHeader"] },
    ]);
    expect(searchStories(ranked, "row").map((l) => l.name)).toEqual(["RowHeader", "ArrowIcon", "Helper"]);
  });

  test("is case-insensitive and empty for a blank query", () => {
    expect(searchStories(leaves, "USERCARD").map((l) => l.name)).toEqual(["UserCard"]);
    expect(searchStories(leaves, "   ")).toEqual([]);
  });
});

test("splitKey separates the file path from the export", () => {
  expect(splitKey("a/b/c--D")).toEqual({ path: "a/b/c", name: "D" });
  expect(splitKey("plain")).toEqual({ path: "", name: "plain" });
});

describe("nestExports", () => {
  const nest = (names: string[]) => {
    const flat = (nodes: ReturnType<typeof nestExports>): unknown[] =>
      nodes.map((n) => (n.children.length ? [n.label, flat(n.children)] : n.label));
    return flat(nestExports(names.map((name) => ({ key: `f--${name}`, name, path: "f" }))));
  };

  test("states of a component nest under it, labelled by what they add", () => {
    expect(nest(["Modal", "ModalEditArmed", "ModalDisabledNfs"])).toEqual([["Modal", ["EditArmed", "DisabledNfs"]]]);
  });

  test("nests under the longest existing prefix, several levels deep", () => {
    expect(nest(["List", "ListDeleted", "ListDeletedTruncated", "ListEmpty"])).toEqual([
      ["List", [["Deleted", ["Truncated"]], "Empty"]],
    ]);
  });

  test("only at a word boundary, and only under an export that exists", () => {
    expect(nest(["Button", "Buttons", "Badge2", "Badge"])).toEqual(["Button", "Buttons", ["Badge", ["2"]]]);
    expect(nest(["CardEmpty", "CardFull"])).toEqual(["CardEmpty", "CardFull"]);
  });

  test("keeps export order within each level", () => {
    expect(nest(["Row", "RowB", "Table", "RowA"])).toEqual([["Row", ["B", "A"]], "Table"]);
  });
});
