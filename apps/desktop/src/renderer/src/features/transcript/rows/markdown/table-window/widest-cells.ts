// Which of a long table's body rows decide its column widths. Under automatic layout a column's
// width comes from two figures over all of its cells: the widest one-line width of a cell, its
// max-content width, and the widest width a cell can narrow to, its min-content width, which under
// the cells' `overflow-wrap: anywhere` is the width of its widest single character. Every row is
// ranked by both from its parsed text, measured in the fonts the cells draw each inline kind in, so
// the browser lays out only the rows holding each column's widest cells and gives every column the
// width the whole table would. Ranking a table that grows ranks only its new rows.

import type { Table, TableCell } from "mdast";

import { type TableCellMeasure } from "./cell-measure.js";

/** One table's body rows ranked by how wide their cells lay out, column by column. */
export class WidestCells {
  readonly #measure: TableCellMeasure;
  #columns: ColumnRanking[] = [];
  /** The table being ranked, and the next of its body rows to rank. */
  #table: Table | undefined;
  #nextIndex = 0;

  public constructor(measure: TableCellMeasure) {
    this.#measure = measure;
  }

  /**
   * Ranks the rows of `table` not yet ranked while `hasTime` answers true, and answers whether
   * every row is. A table given anew, as a streaming one grows, ranks its new rows and its last row
   * again, which the stream may have grown; all of them when that row held a column's widest cell.
   */
  public rank(table: Table, hasTime: () => boolean): boolean {
    const rowCount = Math.max(0, table.children.length - 1);
    if (table !== this.#table) {
      this.#table = table;
      const lastRanked = this.#nextIndex - 1;
      if (rowCount < this.#nextIndex || this.#columns.some((column) => column.holds(lastRanked))) {
        // The row a column's widest cell stood in changed: the ranking starts over.
        this.#columns = [];
        this.#nextIndex = 0;
      } else {
        this.#nextIndex = Math.max(0, lastRanked);
      }
    }
    while (this.#nextIndex < rowCount && hasTime()) {
      const index = this.#nextIndex;
      for (const [columnIndex, cell] of (table.children[index + 1]?.children ?? []).entries()) {
        this.#columns[columnIndex] ??= new ColumnRanking();
        this.#columns[columnIndex].offer(index, cell, this.#measure);
      }
      this.#nextIndex = index + 1;
    }
    return this.#nextIndex >= rowCount;
  }

  /**
   * The body rows the browser must lay out to size `table`'s columns as the whole table: per
   * column, the rows holding its widest one-line cell and its widest character, ascending. Ranks
   * first whatever rows of it are not yet ranked.
   */
  public sampleRowIndexes(table: Table): readonly number[] {
    this.rank(table, () => true);
    const indexes = new Set<number>();
    for (const column of this.#columns) {
      for (const cell of [...column.widestLines(this.#measure), ...column.widestCharacters]) {
        indexes.add(cell.index);
      }
    }
    return [...indexes].sort((left, right) => left - right);
  }
}

/** A cell ranked by one figure. */
interface RankedCell {
  readonly index: number;
  readonly widthPx: number;
}

/** A cell that may hold its column's widest line, by its summed width, measured once asked. */
interface LineCandidate extends RankedCell {
  readonly cell: TableCell;
  measuredPx: number | undefined;
}

/**
 * How far below the widest summed line, as a share of it, a cell's summed line may fall and still
 * be measured: the sum counts each pair's kerning, so only shaping across longer runs is left.
 */
const SUMMED_ERROR_SHARE = 0.02;

/** The most cells measured per column for its widest line: the widest by their summed width. */
const LINE_CANDIDATES = 8;

/** How close to the widest measured cell another must come to be laid out beside it, in pixels. */
const SAME_WIDTH_PX = 1;

/** The most cells kept per column for each figure; ties need only one of them laid out. */
const KEPT_CELLS = 3;

/** One column's widest cells by each figure. */
class ColumnRanking {
  public widestCharacters: RankedCell[] = [];
  #lineCandidates: LineCandidate[] = [];

  /** Whether body row `index` holds one of the column's widest cells. */
  public holds(index: number): boolean {
    return [...this.#lineCandidates, ...this.widestCharacters].some((cell) => cell.index === index);
  }

  public offer(index: number, cell: TableCell, measure: TableCellMeasure): void {
    const summed = measure.sumCell(cell);
    this.widestCharacters = keptCells(
      this.widestCharacters,
      { index, widthPx: summed.widestCharacterPx },
      SAME_WIDTH_PX,
      KEPT_CELLS,
    );
    const widestSummedPx = Math.max(summed.widestLinePx, this.#lineCandidates[0]?.widthPx ?? 0);
    this.#lineCandidates = keptCells(
      this.#lineCandidates,
      { index, widthPx: summed.widestLinePx, cell, measuredPx: undefined },
      SAME_WIDTH_PX + SUMMED_ERROR_SHARE * widestSummedPx,
      LINE_CANDIDATES,
    );
  }

  /** The cells holding the column's widest line, each candidate measured whole once. */
  public widestLines(measure: TableCellMeasure): RankedCell[] {
    const measured = this.#lineCandidates.map((candidate) => {
      candidate.measuredPx ??= measure.measureCell(candidate.cell);
      return { index: candidate.index, widthPx: candidate.measuredPx };
    });
    const widestPx = Math.max(0, ...measured.map((cell) => cell.widthPx));
    return measured
      .filter((cell) => cell.widthPx >= widestPx - SAME_WIDTH_PX)
      .sort((left, right) => right.widthPx - left.widthPx)
      .slice(0, KEPT_CELLS);
  }
}

/**
 * `cells` with `offered` among them, widest first, holding at most `limit` of those within
 * `marginPx` of the widest.
 */
function keptCells<Cell extends RankedCell>(
  cells: readonly Cell[],
  offered: Cell,
  marginPx: number,
  limit: number,
): Cell[] {
  const widestPx = Math.max(offered.widthPx, cells[0]?.widthPx ?? 0);
  if (offered.widthPx < widestPx - marginPx) {
    return cells as Cell[];
  }
  return [...cells, offered]
    .filter((cell) => cell.widthPx >= widestPx - marginPx)
    .sort((left, right) => right.widthPx - left.widthPx)
    .slice(0, limit);
}
