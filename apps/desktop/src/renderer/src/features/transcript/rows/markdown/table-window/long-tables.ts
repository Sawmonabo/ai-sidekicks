// Which tables are long: past how many body rows a table draws as a window over its rows rather
// than whole, which of a parsed block's tables are, and a cheap test of a block's text for whether
// it can hold one before its tree is walked.

import type { Nodes, Table } from "mdast";

import { lineEndOf } from "#renderer/components/Markdown/parse/line-endings.js";

/**
 * The most body rows a table is drawn whole with; a longer one draws only its rows near the
 * viewport. Measured, a table of agent-style rows drawn whole at this count takes about five
 * milliseconds of the main thread to render and lay out past its parse, some 0.1 ms a row.
 */
export const WHOLE_TABLE_MAX_BODY_ROWS = 48;

/** The tables in `node` with more body rows than are drawn whole, in document order. */
export function longTablesOf(node: Nodes): Table[] {
  if (node.type === "table") {
    return node.children.length - 1 > WHOLE_TABLE_MAX_BODY_ROWS ? [node] : [];
  }
  return "children" in node ? node.children.flatMap((child) => longTablesOf(child)) : [];
}

/**
 * Whether `source` can hold a long table: more lines holding a cell divider than a table drawn
 * whole has rows, its head and delimiter lines counted. Read from the text, so a block that cannot
 * hold one never has its tree walked for it; one that passes may still hold none.
 */
export function mayHoldLongTable(source: string): boolean {
  // From each divider to the next one after its line, so the text is read once.
  let lineCount = 0;
  for (
    let divider = source.indexOf("|");
    divider !== -1;
    divider = source.indexOf("|", lineEndOf(source, divider))
  ) {
    lineCount += 1;
    if (lineCount > WHOLE_TABLE_MAX_BODY_ROWS + 2) {
      return true;
    }
  }
  return false;
}
