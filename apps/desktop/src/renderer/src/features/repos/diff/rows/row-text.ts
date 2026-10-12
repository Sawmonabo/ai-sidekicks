// The words a diff row is drawn with beside its code, and the text the flow's rows copy as. A copy
// of the conversation reads drawn rows as their elements' text, each row a line; a block opened
// whole draws only the rows near the reader, so a copy across the rows it has not drawn reads them
// here, as the same text the rows would copy as drawn.

import { toText } from "hast-util-to-text";

import { type DiffLineKind } from "../model.js";
import { type DiffFlowRows, diffFlowLineNumber } from "./flow.js";

/** The flow's signs: a context line's cell is blank and keeps its width. */
export const DIFF_FLOW_SIGNS: Readonly<Record<DiffLineKind, string>> = {
  context: "",
  insert: "+",
  delete: "−",
};

/** Announced text per line kind, so the sign is not the only carrier. */
export const DIFF_LINE_KIND_LABELS: Readonly<Record<DiffLineKind, string>> = {
  context: "unchanged",
  insert: "added",
  delete: "removed",
};

/**
 * The patch's `\ No newline at end of file` without the leading `\`, which the row already
 * conveys by drawing it inside the line. On a newline-only change it is the only thing that
 * tells the two rows apart.
 */
export const DIFF_NO_NEWLINE_AT_END_LABEL = "No newline at end of file";

/**
 * Three middle dots, the skipped-lines mark: a midline ellipsis drawn in the app's own face, which
 * has no midline ellipsis of its own. Set in sans, three of them span what one midline ellipsis
 * does.
 */
export const DIFF_SKIPPED_LINES_MARK = "···";

/** What a screen reader hears for the flow's separator where a file's lines are skipped. */
export const DIFF_SKIPPED_LINES_LABEL = "Lines skipped";

/**
 * The text the flow's rows `firstIndex` to before `endIndex` copy as, one line each, as a copy
 * reads them drawn: each row read from the elements it is drawn with, so its whitespace runs
 * together as it does there. Throws for a file's header or the reason it is not shown, which only a
 * file with no lines draws, and which is never opened whole.
 */
export function diffFlowRowsText(
  flowRows: DiffFlowRows,
  firstIndex: number,
  endIndex: number,
): string {
  const rows: TextElement[] = [];
  for (let rowIndex = firstIndex; rowIndex < endIndex; rowIndex += 1) {
    const row = flowRows.rows[rowIndex];
    if (row !== undefined) {
      rows.push(elementOf("div", [elementOf("span", rowParts(flowRows, row))]));
    }
  }
  return toText({ type: "root", children: rows });
}

/** An element of the tree a copy reads text from. */
type TextElement = Extract<Parameters<typeof toText>[0], { type: "element" }>;

/** One row's parts in the elements its cell draws them in, in their order there. */
function rowParts(flowRows: DiffFlowRows, row: DiffFlowRows["rows"][number]): TextElement[] {
  if (row.kind === "file-header" || row.kind === "unshown-reason") {
    throw new Error("A diff block opened whole drew a file's header.");
  }
  if (row.kind === "hunk-header" || row.kind === "gap") {
    return [
      textElementOf("span", DIFF_SKIPPED_LINES_MARK),
      textElementOf("span", DIFF_SKIPPED_LINES_LABEL),
    ];
  }
  const line = flowRows.index.lineFor(row);
  const lineNumber = diffFlowLineNumber(line);
  return [
    textElementOf("span", lineNumber === undefined ? "" : String(lineNumber)),
    textElementOf("span", DIFF_FLOW_SIGNS[line.kind]),
    textElementOf("span", DIFF_LINE_KIND_LABELS[line.kind]),
    textElementOf("code", line.segments.map((segment) => segment.text).join("")),
    ...(line.noNewlineAtEnd === true ? [textElementOf("span", DIFF_NO_NEWLINE_AT_END_LABEL)] : []),
  ];
}

function textElementOf(tagName: string, value: string): TextElement {
  return elementOf(tagName, [{ type: "text", value }]);
}

function elementOf(tagName: string, children: TextElement["children"]): TextElement {
  return { type: "element", tagName, properties: {}, children };
}
