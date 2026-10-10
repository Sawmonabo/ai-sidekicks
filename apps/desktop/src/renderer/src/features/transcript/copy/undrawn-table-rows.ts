// A long table's rows the window has not drawn, read back into a copy from its row's body text.
// Each spacer row standing for undrawn rows names the text they were parsed from and the table's
// column count; the copy gives the spacer that text under a blank head of that width, which the
// drawn part's reading parses in the spacer's place under the screen's own policy, so the rows copy
// exactly as drawn rows do.

import {
  UNDRAWN_ROWS_MARKDOWN_PROPERTY,
  type DrawnTree,
} from "#renderer/components/Markdown/drawn-text.js";

/**
 * `tree` with every spacer row that names a text range holding the markdown of the rows that text
 * makes, for the drawn part's reading to parse in its place. `readBodyText` reads the text of the
 * row's body, which the ranges index; it is read only when a spacer is found. Throws when the body
 * has no text to read them from, since a copy missing rows would look whole.
 */
export function withUndrawnTableRows(
  tree: DrawnTree,
  readBodyText: () => string | undefined,
): DrawnTree {
  let bodyText: string | undefined;
  const textOfBody = (): string => {
    bodyText ??= readBodyText();
    if (bodyText === undefined) {
      throw new Error("A copied table's undrawn rows have no text to be read from.");
    }
    return bodyText;
  };
  if ("children" in tree) {
    markSpacers(tree, textOfBody);
  }
  return tree;
}

/** A node of a drawn tree that holds children. */
type ParentNode = Extract<DrawnTree, { children: unknown }>;

/** Gives each spacer row under `parent` the markdown of the rows it stands for. */
function markSpacers(parent: ParentNode, textOfBody: () => string): void {
  for (const child of parent.children) {
    if (child.type !== "element") {
      continue;
    }
    const start = numberOf(child.properties["dataMarkdownSourceStart"]);
    const end = numberOf(child.properties["dataMarkdownSourceEnd"]);
    const columnCount = numberOf(child.properties["dataMarkdownColumnCount"]);
    if (
      child.tagName === "tr" &&
      start !== undefined &&
      end !== undefined &&
      columnCount !== undefined
    ) {
      child.properties[UNDRAWN_ROWS_MARKDOWN_PROPERTY] = undrawnRowsMarkdown(
        textOfBody(),
        start,
        end,
        columnCount,
      );
    } else {
      markSpacers(child, textOfBody);
    }
  }
}

/** A property's number, read as the DOM reader keeps it: a number, or the attribute's text. */
function numberOf(value: unknown): number | undefined {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : undefined;
}

/**
 * The markdown of the rows the text from `start` to `end` holds, as a table of `columnCount`
 * columns under a blank head. A table inside a quote or a list repeats its container's marks
 * before every line, so the marks before the first row are cut from the start of each line after
 * it.
 */
function undrawnRowsMarkdown(
  bodyText: string,
  start: number,
  end: number,
  columnCount: number,
): string {
  const containerMarks = bodyText.slice(bodyText.lastIndexOf("\n", start - 1) + 1, start);
  const lines = bodyText
    .slice(start, end)
    .split("\n")
    .map((line, index) =>
      index > 0 && containerMarks !== "" && line.startsWith(containerMarks)
        ? line.slice(containerMarks.length)
        : line,
    );
  const blankHead = `|${" |".repeat(columnCount)}\n|${" --- |".repeat(columnCount)}\n`;
  return blankHead + lines.join("\n");
}
