// A drawn part of a reply read back into the text it copies as: the markdown that drew it, rebuilt
// from the drawing's own elements, or its plain text laid out as the screen lays it out. A long
// table's rows the screen never drew stand in the tree as one row holding their markdown, which is
// parsed into rows under the screen's own policy before the part is read, so they read exactly as
// drawn rows do. The page and the markdown worker both read a part here, so a part read off the
// page's thread is the same text as one read on it.

import { type fromDom } from "hast-util-from-dom";
import { defaultHandlers, toMdast, type Handle } from "hast-util-to-mdast";
import { toText } from "hast-util-to-text";
import { gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown } from "mdast-util-to-markdown";

import { markdownTableBodyRows } from "./html.js";

/** A tree of drawn elements, as the DOM reader builds it. */
export type DrawnTree = ReturnType<typeof fromDom>;

/** How a drawn part is copied: as the markdown that drew it, or as plain text. */
export type CopyFlavor = "markdown" | "text";

/**
 * The property of a table row standing for rows the screen did not draw, holding their markdown
 * as body rows under a blank head of the table's width.
 */
export const UNDRAWN_ROWS_MARKDOWN_PROPERTY = "dataUndrawnRowsMarkdown";

/**
 * The text `tree` copies as in `flavor`, its undrawn rows parsed in their stand-in's place. Reads
 * `tree` by changing it, so a tree is read once.
 */
export function drawnTreeText(tree: DrawnTree, flavor: CopyFlavor): string {
  if ("children" in tree) {
    fillUndrawnRows(tree);
  }
  return flavor === "markdown" ? rebuildMarkdown(tree) : toText(tree);
}

/** How many characters `tree` holds: its text, and the markdown of its undrawn rows. */
export function drawnTreeLength(tree: DrawnTree): number {
  if (tree.type === "text") {
    return tree.value.length;
  }
  if (!("children" in tree)) {
    return 0;
  }
  let length = 0;
  for (const child of tree.children) {
    const undrawnRows =
      child.type === "element" ? child.properties[UNDRAWN_ROWS_MARKDOWN_PROPERTY] : undefined;
    length += typeof undrawnRows === "string" ? undrawnRows.length : drawnTreeLength(child);
  }
  return length;
}

/** A node of a drawn tree that holds children. */
type ParentNode = Extract<DrawnTree, { children: unknown }>;

/** One child of a drawn tree's node. */
type ChildNode = ParentNode["children"][number];

/** Puts the rows each undrawn rows' stand-in under `parent` holds the markdown of in its place. */
function fillUndrawnRows(parent: ParentNode): void {
  parent.children = parent.children.flatMap((child): ChildNode[] => {
    if (child.type !== "element") {
      return [child];
    }
    const undrawnRows = child.properties[UNDRAWN_ROWS_MARKDOWN_PROPERTY];
    if (typeof undrawnRows === "string") {
      return markdownTableBodyRows(undrawnRows);
    }
    fillUndrawnRows(child);
    return [child];
  });
}

/** The markdown that made the drawn reply elements in `tree`, rebuilt from them. */
function rebuildMarkdown(tree: DrawnTree): string {
  const markdownTree = toMdast(tree, { handlers: DRAWN_MARKDOWN_HANDLERS });
  // `-` is the bullet agents and people write most; the drawing does not keep which one was used.
  return toMarkdown(markdownTree, { bullet: "-", extensions: [gfmToMarkdown()] }).trimEnd();
}

/** What one element handler answers, derived from the library's own handler. */
type RebuiltNodes = ReturnType<Handle>;

/** One element of a drawn tree, as a handler is handed it. */
type DrawnElement = Parameters<Handle>[1];

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
