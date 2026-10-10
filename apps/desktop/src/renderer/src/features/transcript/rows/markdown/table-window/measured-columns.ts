// The columns a long table is held at, read from the table as automatic layout drew it: its head
// cells' widths and its own. The table read is drawn with its head and the rows that set its
// widths, so the browser sizes the columns exactly as it would size them for the whole table, from
// the cells that decide them.

import { type HeldTableColumns } from "#renderer/components/Markdown/table-offer.js";

/**
 * The columns of `table`, laid out in automatic mode with its head row drawn. Reading them lays
 * the table out. Throws for a table with no head row, which a long table always has.
 */
export function measureTableColumns(table: HTMLTableElement): HeldTableColumns {
  const headCells = [...(table.tHead?.rows[0]?.cells ?? [])];
  if (headCells.length === 0) {
    throw new Error("A long table was measured with no head row drawn.");
  }
  return {
    widthsPx: headCells.map((cell) => cell.getBoundingClientRect().width),
    tableWidthPx: table.getBoundingClientRect().width,
  };
}
