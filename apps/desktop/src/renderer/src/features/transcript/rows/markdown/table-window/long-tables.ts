// Which tables are long: past how many body rows a table draws as a window over its rows rather
// than whole, which of a parsed block's tables are, and a cheap test of a block's text for whether
// it can hold one before it is parsed.

import type { Nodes, Table } from "mdast";

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
 * whole has rows, its head and delimiter lines counted. Read without parsing, so a block that
 * cannot hold one is never parsed for it; one that passes may still hold none.
 */
export function mayHoldLongTable(source: string): boolean {
  let lineCount = 0;
  let lineStart = 0;
  while (lineStart < source.length) {
    const lineEnd = source.indexOf("\n", lineStart);
    const end = lineEnd === -1 ? source.length : lineEnd;
    const divider = source.indexOf("|", lineStart);
    if (divider !== -1 && divider < end) {
      lineCount += 1;
      if (lineCount > WHOLE_TABLE_MAX_BODY_ROWS + 2) {
        return true;
      }
    }
    lineStart = end + 1;
  }
  return false;
}
