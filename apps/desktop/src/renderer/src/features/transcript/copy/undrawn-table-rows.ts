// A long table's rows the window has not drawn, read back into a copy from its row's body text.
// Each spacer row standing for undrawn rows names the text they were parsed from and the table's
// column count; the copy parses that text under a blank head of that width and puts the rows it
// makes in the spacer's place, drawn under the screen's own policy, so they copy exactly as drawn
// rows do. A short run of rows is parsed at once; a long one by the markdown worker, off the page's
// thread, after every spacer's text has been read.

import {
  makeMarkdownTableBodyRows,
  markdownWorker,
} from "#renderer/components/Markdown/worker/connection.js";
import { type DrawnTree } from "./clipboard-flavors.js";

/**
 * `tree` with every spacer row that names a text range replaced by the rows that text makes: at
 * once when every run is short, otherwise once the markdown worker has made the long ones, which
 * rejects with the worker's `Error`. `readBodyText` reads the text of the row's body, which the
 * ranges index; it is read only when a spacer is found, and before anything is waited on. Throws
 * when the body has no text to read them from, since a copy missing rows would look whole.
 */
export function withUndrawnTableRows(
  tree: DrawnTree,
  readBodyText: () => string | undefined,
): DrawnTree | Promise<DrawnTree> {
  let bodyText: string | undefined;
  const textOfBody = (): string => {
    bodyText ??= readBodyText();
    if (bodyText === undefined) {
      throw new Error("A copied table's undrawn rows have no text to be read from.");
    }
    return bodyText;
  };
  const awaitedRows: Promise<void>[] = [];
  if ("children" in tree) {
    fillSpacers(tree, textOfBody, awaitedRows);
  }
  return awaitedRows.length === 0 ? tree : Promise.all(awaitedRows).then(() => tree);
}

/** A node of a drawn tree that holds children. */
type ParentNode = Extract<DrawnTree, { children: unknown }>;

/** One child of a drawn tree's node. */
type ChildNode = ParentNode["children"][number];

/**
 * Puts each spacer's rows in its place under `parent`; a spacer whose rows the worker makes stays
 * until they come, and the wait for them joins `awaitedRows`.
 */
function fillSpacers(
  parent: ParentNode,
  textOfBody: () => string,
  awaitedRows: Promise<void>[],
): void {
  for (const child of [...parent.children]) {
    if (child.type !== "element") {
      continue;
    }
    const start = numberOf(child.properties["dataMarkdownSourceStart"]);
    const end = numberOf(child.properties["dataMarkdownSourceEnd"]);
    const columnCount = numberOf(child.properties["dataMarkdownColumnCount"]);
    if (
      child.tagName !== "tr" ||
      start === undefined ||
      end === undefined ||
      columnCount === undefined
    ) {
      fillSpacers(child, textOfBody, awaitedRows);
      continue;
    }
    const rows = makeMarkdownTableBodyRows(
      undrawnRowsMarkdown(textOfBody(), start, end, columnCount),
      markdownWorker,
    );
    if (rows instanceof Promise) {
      awaitedRows.push(
        rows.then((madeRows) => {
          replaceSpacer(parent, child, madeRows);
        }),
      );
    } else {
      replaceSpacer(parent, child, rows);
    }
  }
}

/** `parent` with `spacer` replaced by `rows`, in its place. */
function replaceSpacer(parent: ParentNode, spacer: ChildNode, rows: readonly ChildNode[]): void {
  parent.children = parent.children.flatMap((child) => (child === spacer ? [...rows] : [child]));
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
