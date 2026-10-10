// A long table's rows the window has not drawn, read back into a copy from the row's text. Each
// spacer row standing for undrawn rows names the text they were parsed from; the copy parses that
// text under a blank head of the table's width and puts the rows it makes in the spacer's place,
// drawn under the screen's own policy, so they copy exactly as drawn rows do.

import { markdownToHast, type DrawnTree } from "./clipboard-flavors.js";

/**
 * `tree` with every spacer row that names a text range replaced by the rows that text makes.
 * `readRowText` reads the row's whole text, which the ranges index; it is read only when a spacer
 * is found. Throws when the row has no text to read them from, since a copy missing rows would
 * look whole.
 */
export function withUndrawnTableRows(
  tree: DrawnTree,
  readRowText: () => string | undefined,
): DrawnTree {
  let rowText: string | undefined;
  const textOfRow = (): string => {
    rowText ??= readRowText();
    if (rowText === undefined) {
      throw new Error("A copied table's undrawn rows have no text to be read from.");
    }
    return rowText;
  };
  if ("children" in tree) {
    fillSpacers(tree, textOfRow);
  }
  return tree;
}

/** A node of a drawn tree that holds children. */
type ParentNode = Extract<DrawnTree, { children: unknown }>;

/** One child of a drawn tree's node. */
type ChildNode = ParentNode["children"][number];

function fillSpacers(parent: ParentNode, textOfRow: () => string): void {
  parent.children = parent.children.flatMap((child): ChildNode[] => {
    if (child.type !== "element") {
      return [child];
    }
    const start = numberOf(child.properties["dataMarkdownSourceStart"]);
    const end = numberOf(child.properties["dataMarkdownSourceEnd"]);
    if (child.tagName === "tr" && start !== undefined && end !== undefined) {
      return undrawnRows(textOfRow(), start, end, columnCountOf(child));
    }
    fillSpacers(child, textOfRow);
    return [child];
  });
}

/** How many columns a spacer row spans: a cell for each. */
function columnCountOf(spacer: ChildNode): number {
  return "children" in spacer
    ? spacer.children.filter((cell) => cell.type === "element").length
    : 1;
}

/** A property's number, read as the DOM reader keeps it: a number, or the attribute's text. */
function numberOf(value: unknown): number | undefined {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : undefined;
}

/**
 * The rows the text from `start` to `end` makes, as table rows of `columnCount` cells. A table
 * inside a quote or a list repeats its container's marks before every line, so the marks before
 * the first row are cut from the start of each line after it.
 */
function undrawnRows(
  rowText: string,
  start: number,
  end: number,
  columnCount: number,
): ChildNode[] {
  const containerMarks = rowText.slice(rowText.lastIndexOf("\n", start - 1) + 1, start);
  const lines = rowText
    .slice(start, end)
    .split("\n")
    .map((line, index) =>
      index > 0 && containerMarks !== "" && line.startsWith(containerMarks)
        ? line.slice(containerMarks.length)
        : line,
    );
  const blankHead = `|${" |".repeat(columnCount)}\n|${" --- |".repeat(columnCount)}\n`;
  return bodyRowsOf(markdownToHast(blankHead + lines.join("\n")));
}

/** The body rows of the one table `tree` holds. */
function bodyRowsOf(tree: ReturnType<typeof markdownToHast>): ChildNode[] {
  if (!("children" in tree)) {
    return [];
  }
  for (const child of tree.children) {
    if (child.type !== "element") {
      continue;
    }
    if (child.tagName === "tbody") {
      return child.children.filter((row) => row.type === "element");
    }
    const rows = bodyRowsOf(child);
    if (rows.length > 0) {
      return rows;
    }
  }
  return [];
}
