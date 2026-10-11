// A drawn part of a reply read back into the text it copies as: the markdown that drew it, rebuilt
// from the drawing's own elements, or its plain text laid out as the screen lays it out. A long
// table's rows the screen never drew stand in the tree as one row naming its table and the rows;
// the table's block is parsed again from what it was parsed from and the rows taken from the table
// there, drawn under the screen's own policy, before the part is read, so they read exactly as
// drawn rows do. The page and the markdown worker both read a part here, so a part read off the
// page's thread is the same text as one read on it.

import { type fromDom } from "hast-util-from-dom";
import { defaultHandlers, toMdast, type Handle } from "hast-util-to-mdast";
import { toText } from "hast-util-to-text";
import type { Nodes as MarkdownNodes, Table } from "mdast";
import { gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown } from "mdast-util-to-markdown";

import { screenTableBodyRows, type MarkdownHastElement } from "./html.js";
import { parseBlockAgain, type BlockParseSource } from "./parse.js";

/** A tree of drawn elements, as the DOM reader builds it. */
export type DrawnTree = ReturnType<typeof fromDom>;

/** One element of a drawn tree. */
export type DrawnElement = Parameters<Handle>[1];

/** How a drawn part is copied: as the markdown that drew it, or as plain text. */
export type CopyFlavor = "markdown" | "text";

/** A run of a long table's body rows the screen did not draw, and the table they belong to. */
export interface UndrawnTableRows {
  /** What names the table, and what its block was parsed from, among one drawn part's tables. */
  readonly tableKey: string;
  /** Where the table starts in its block's parse, which counts the definitions' length too. */
  readonly tableStart: number;
  /** The first and last undrawn body rows, counted from the first row below the head. */
  readonly firstIndex: number;
  readonly lastIndex: number;
}

/**
 * The text `tree` copies as in `flavor`, its undrawn rows read in their stand-in's place from the
 * block `blockSourceOf` answers for the key they name. Reads `tree` by changing it, so a tree is
 * read once. Throws when a stand-in's block is not answered or holds no table where it names one.
 */
export function drawnTreeText(
  tree: DrawnTree,
  flavor: CopyFlavor,
  blockSourceOf: (tableKey: string) => BlockParseSource | undefined,
): string {
  if ("children" in tree) {
    fillUndrawnRows(tree, blockSourceOf, new Map());
  }
  return flavor === "markdown" ? rebuildMarkdown(tree) : toText(tree);
}

/** How many characters of text `tree` holds. */
export function drawnTreeLength(tree: DrawnTree): number {
  if (tree.type === "text") {
    return tree.value.length;
  }
  if (!("children" in tree)) {
    return 0;
  }
  let length = 0;
  for (const child of tree.children) {
    length += drawnTreeLength(child);
  }
  return length;
}

/** Makes `row`, a drawn table's row, the stand-in for the body rows `undrawnRows` names. */
export function markUndrawnRows(row: DrawnElement, undrawnRows: UndrawnTableRows): void {
  row.properties[UNDRAWN_ROWS_PROPERTIES.tableKey] = undrawnRows.tableKey;
  row.properties[UNDRAWN_ROWS_PROPERTIES.tableStart] = undrawnRows.tableStart;
  row.properties[UNDRAWN_ROWS_PROPERTIES.firstIndex] = undrawnRows.firstIndex;
  row.properties[UNDRAWN_ROWS_PROPERTIES.lastIndex] = undrawnRows.lastIndex;
}

/**
 * The plain text of body rows `firstIndex` to `lastIndex` of `table`, as the screen draws them,
 * read as a drawn table's rows read: each row a line of its own, its cells joined by a tab.
 */
export function drawnRowsText(table: Table, firstIndex: number, lastIndex: number): string {
  return toText({
    type: "element",
    tagName: "table",
    properties: {},
    children: screenTableBodyRows(table, firstIndex, lastIndex).map(asDrawnRow),
  });
}

/** The properties a stand-in row carries the undrawn rows it stands for on, one per member. */
const UNDRAWN_ROWS_PROPERTIES = {
  tableKey: "dataUndrawnTableKey",
  tableStart: "dataUndrawnTableStart",
  firstIndex: "dataUndrawnFirstRow",
  lastIndex: "dataUndrawnLastRow",
} as const;

/** The undrawn rows `element` stands for, or `undefined` for an element standing for none. */
function undrawnRowsOf(element: DrawnElement): UndrawnTableRows | undefined {
  const property = (name: keyof typeof UNDRAWN_ROWS_PROPERTIES): unknown =>
    element.properties[UNDRAWN_ROWS_PROPERTIES[name]];
  const tableKey = property("tableKey");
  const tableStart = property("tableStart");
  const firstIndex = property("firstIndex");
  const lastIndex = property("lastIndex");
  return typeof tableKey === "string" &&
    typeof tableStart === "number" &&
    typeof firstIndex === "number" &&
    typeof lastIndex === "number"
    ? { tableKey, tableStart, firstIndex, lastIndex }
    : undefined;
}

/** A node of a drawn tree that holds children. */
type ParentNode = Extract<DrawnTree, { children: unknown }>;

/** One child of a drawn tree's node. */
type ChildNode = ParentNode["children"][number];

/**
 * Puts the rows each stand-in under `parent` stands for in its place, each table's block, as
 * `blockSourceOf` answers it, parsed once and the table kept in `tables` by its key. Throws for a
 * stand-in whose block is not answered.
 */
function fillUndrawnRows(
  parent: ParentNode,
  blockSourceOf: (tableKey: string) => BlockParseSource | undefined,
  tables: Map<string, Table>,
): void {
  parent.children = parent.children.flatMap((child): ChildNode[] => {
    if (child.type !== "element") {
      return [child];
    }
    const undrawnRows = undrawnRowsOf(child);
    if (undrawnRows === undefined) {
      fillUndrawnRows(child, blockSourceOf, tables);
      return [child];
    }
    let table = tables.get(undrawnRows.tableKey);
    if (table === undefined) {
      const blockSource = blockSourceOf(undrawnRows.tableKey);
      if (blockSource === undefined) {
        throw new Error("A copied table's undrawn rows have no block to be read from.");
      }
      table = tableAt(parseBlockAgain(blockSource), undrawnRows.tableStart);
      tables.set(undrawnRows.tableKey, table);
    }
    return screenTableBodyRows(table, undrawnRows.firstIndex, undrawnRows.lastIndex).map(
      asDrawnRow,
    );
  });
}

/**
 * The table starting at `start` in `node`'s parse. Throws when none starts there: the copy would
 * miss rows yet look whole.
 */
function tableAt(node: MarkdownNodes, start: number): Table {
  if (node.type === "table" && node.position?.start.offset === start) {
    return node;
  }
  if ("children" in node) {
    for (const child of node.children) {
      const childStart = child.position?.start.offset ?? 0;
      const childEnd = child.position?.end.offset ?? 0;
      if (childStart <= start && start < childEnd) {
        return tableAt(child, start);
      }
    }
  }
  throw new Error("A copied table's undrawn rows are not where its block was parsed.");
}

/**
 * `row` with only its cells, as the screen draws it: the parse puts a line break between cells,
 * which plain text would read as spaces around each cell.
 */
function asDrawnRow(row: MarkdownHastElement): MarkdownHastElement {
  return { ...row, children: row.children.filter((cell) => cell.type === "element") };
}

/** The markdown that made the drawn reply elements in `tree`, rebuilt from them. */
function rebuildMarkdown(tree: DrawnTree): string {
  const markdownTree = toMdast(tree, { handlers: DRAWN_MARKDOWN_HANDLERS });
  // `-` is the bullet agents and people write most; the drawing does not keep which one was used.
  return toMarkdown(markdownTree, { bullet: "-", extensions: [gfmToMarkdown()] }).trimEnd();
}

/** What one element handler answers, derived from the library's own handler. */
type RebuiltNodes = ReturnType<Handle>;

/**
 * How the markdown drawing's own elements read back: a heading is a `p` carrying its level, a
 * list item is tight unless marked loose, a fenced block names its language on the `pre`, and a
 * table cell carries its column's alignment as `data-align`, which the table's reader takes from
 * `align`.
 */
const DRAWN_MARKDOWN_HANDLERS: Record<string, Handle> = {
  p: (state, element) => {
    const level = Number(element.properties["ariaLevel"]);
    return element.properties["role"] === "heading" && isHeadingDepth(level)
      ? ({ type: "heading", depth: level, children: state.all(element) } as RebuiltNodes)
      : defaultHandlers.p(state, element);
  },
  li: (state, element) => ({
    ...defaultHandlers.li(state, element),
    spread: element.properties["dataSpread"] !== undefined,
  }),
  pre: (state, element) => {
    const language = element.properties["dataLanguage"];
    const code = defaultHandlers.pre(state, element);
    return typeof language === "string" ? { ...code, lang: language } : code;
  },
  table: (state, element) => {
    alignCellsOf(element);
    return defaultHandlers.table(state, element);
  },
};

/** Gives each cell of a drawn table, nested tables aside, the `align` its `data-align` names. */
function alignCellsOf(parent: DrawnElement): void {
  for (const child of parent.children) {
    if (child.type !== "element" || child.tagName === "table") {
      continue;
    }
    const alignment = child.properties["dataAlign"];
    if ((child.tagName === "td" || child.tagName === "th") && typeof alignment === "string") {
      child.properties["align"] = alignment;
    }
    alignCellsOf(child);
  }
}

function isHeadingDepth(level: number): level is 1 | 2 | 3 | 4 | 5 | 6 {
  return Number.isInteger(level) && level >= 1 && level <= 6;
}
