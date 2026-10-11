// The HTML a markdown text makes under the screen's own policy: no anchor and no image, and a raw
// HTML line is text, never markup. The page and the markdown worker both make it here, so a text
// made into HTML off the page's thread is the same bytes as one made on it, and a table's body
// rows the same tree.

import { toHtml } from "hast-util-to-html";
import type { Nodes, Parents, Table, TableRow } from "mdast";
import { toHast, type Handlers } from "mdast-util-to-hast";

import { parseMarkdown } from "./parse.js";

/** One element of the tree `markdownToHast` makes, below its root. */
export type MarkdownHastElement = Extract<
  Extract<ReturnType<typeof markdownToHast>, { children: unknown }>["children"][number],
  { type: "element" }
>;

/** The HTML `markdown` makes, as the screen would draw it. */
export function markdownToHtml(markdown: string): string {
  return toHtml(markdownToHast(markdown));
}

/** The elements `markdown` makes under the screen's own policy, as a tree. */
export function markdownToHast(markdown: string): ReturnType<typeof toHast> {
  return toHast(parseMarkdown(markdown), { handlers: SCREEN_POLICY_HANDLERS });
}

/**
 * The HTML of the body rows of the first table in the markdown tree `tree`, as `markdownToHtml`
 * writes them for the same table: under the screen's policy, a line break between each.
 */
export function tableBodyRowsHtml(tree: Nodes): string {
  return bodyRowsOf(toHast(tree, { handlers: SCREEN_POLICY_HANDLERS }))
    .map((row) => toHtml(row))
    .join("\n");
}

/**
 * `rows`, body rows of a table aligned `align`, as elements drawn as the screen draws a table's
 * rows, a footnote marker among them.
 */
export function screenTableBodyRows(
  align: Table["align"],
  rows: readonly TableRow[],
): MarkdownHastElement[] {
  // Under a head row the rows are body rows, as they are in the whole table; the head is not read.
  const rowsUnderHead: Table = {
    type: "table",
    align,
    children: [{ type: "tableRow", children: [] }, ...rows],
  };
  return bodyRowsOf(
    toHast({ type: "root", children: [rowsUnderHead] }, { handlers: SCREEN_TABLE_ROW_HANDLERS }),
  );
}

/** The screen draws a link as its text, an image as its alt text and raw HTML as literal text. */
const SCREEN_POLICY_HANDLERS: Handlers = {
  link: (state, node) => state.all(node),
  linkReference: (state, node) => state.all(node),
  image: (_state, node: { alt?: string | null }) => ({ type: "text", value: node.alt ?? "" }),
  imageReference: (_state, node: { alt?: string | null }) => ({
    type: "text",
    value: node.alt ?? "",
  }),
  html: (_state, node: { value: string }) => ({ type: "text", value: node.value }),
};

/**
 * A table row's cells drawn as the screen draws them: each cell the parse made, however many the
 * head declares, under the screen's policy, and a footnote marker as its label in a `sup`, not as
 * a numbered link to a footnotes section.
 */
const SCREEN_TABLE_ROW_HANDLERS: Handlers = {
  ...SCREEN_POLICY_HANDLERS,
  tableRow: (state, row: TableRow, parent: Parents | undefined) => {
    const align = parent?.type === "table" ? parent.align : undefined;
    const tagName = parent?.children[0] === row ? "th" : "td";
    const cells = row.children.map((cell, columnIndex) => {
      const alignment = align?.[columnIndex];
      return {
        type: "element" as const,
        tagName,
        properties: alignment === null || alignment === undefined ? {} : { align: alignment },
        children: state.all(cell),
      };
    });
    return { type: "element", tagName: "tr", properties: {}, children: state.wrap(cells, true) };
  },
  footnoteReference: (_state, node: { identifier: string; label?: string | null }) => ({
    type: "element",
    tagName: "sup",
    properties: {},
    children: [{ type: "text", value: node.label ?? node.identifier }],
  }),
};

/** The body rows of the first table `tree` holds. */
function bodyRowsOf(tree: ReturnType<typeof markdownToHast>): MarkdownHastElement[] {
  if (!("children" in tree)) {
    return [];
  }
  for (const child of tree.children) {
    if (child.type !== "element") {
      continue;
    }
    if (child.tagName === "tbody") {
      return child.children.filter((row): row is MarkdownHastElement => row.type === "element");
    }
    const rows = bodyRowsOf(child);
    if (rows.length > 0) {
      return rows;
    }
  }
  return [];
}
