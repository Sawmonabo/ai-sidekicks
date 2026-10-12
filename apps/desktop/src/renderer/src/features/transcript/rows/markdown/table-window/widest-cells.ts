// Which of a long table's body rows decide its column widths. Under automatic layout a column's
// width comes from two figures over all of its cells: the widest one-line width of a cell, its
// max-content width, and the widest width a cell can narrow to, its min-content width, which under
// the cells' `overflow-wrap: anywhere` is the width of its widest single character. Every row is
// ranked by both from its parsed text, measured in the fonts the cells draw each inline kind in, so
// the browser lays out only the rows holding each column's widest cells and gives every column the
// width the whole table would. Ranking a table that grows ranks only its new rows.

import type { Table, TableCell, TableRow } from "mdast";

import { passTableRows } from "#renderer/components/Markdown/parse/table-rows.js";
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
   * Takes `table` to rank and answers the first of its body rows not yet ranked. A table given
   * anew, as a streaming one grows, ranks its new rows and its last row again, which the stream may
   * have grown; all of them when that row held a column's widest cell.
   */
  public resume(table: Table): number {
    if (table !== this.#table) {
      this.#table = table;
      const lastRanked = this.#nextIndex - 1;
      if (
        bodyRowCountOf(table) < this.#nextIndex ||
        this.#columns.some((column) => column.holds(lastRanked))
      ) {
        // The row a column's widest cell stood in changed: the ranking starts over.
        this.#columns = [];
        this.#nextIndex = 0;
      } else {
        this.#nextIndex = Math.max(0, lastRanked);
      }
    }
    return this.#nextIndex;
  }

  /** Ranks body row `index` of the table last taken: the row after the last one ranked. */
  public rank(index: number, row: TableRow): void {
    // Counted by hand: `entries()` would make a pair for every cell of every row.
    let columnIndex = 0;
    for (const cell of row.children) {
      const column = (this.#columns[columnIndex] ??= new ColumnRanking());
      column.offer(index, cell, this.#measure);
      columnIndex += 1;
    }
    this.#nextIndex = index + 1;
  }

  /**
   * Ranks every body row of `table` not yet ranked that can be read now, and answers whether every
   * one is ranked.
   */
  public rankReadRows(table: Table): boolean {
    const rowCount = bodyRowCountOf(table);
    passTableRows(table, this.resume(table), rowCount - 1, (row, index) => {
      this.rank(index, row);
      return true;
    });
    return this.#nextIndex >= rowCount;
  }

  /**
   * The body rows the browser must lay out to size the table's columns as the whole table: per
   * column, the rows holding its widest one-line cell and its widest character, ascending;
   * `undefined` while a row of the table last taken is not ranked.
   */
  public sampleRowIndexes(): readonly number[] | undefined {
    if (this.#table === undefined || this.#nextIndex < bodyRowCountOf(this.#table)) {
      return undefined;
    }
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

/** One column's widest cells by each figure, each list widest first and kept in place. */
class ColumnRanking {
  public readonly widestCharacters: RankedCell[] = [];
  readonly #lineCandidates: LineCandidate[] = [];

  /** Whether body row `index` holds one of the column's widest cells. */
  public holds(index: number): boolean {
    return [...this.#lineCandidates, ...this.widestCharacters].some((cell) => cell.index === index);
  }

  public offer(index: number, cell: TableCell, measure: TableCellMeasure): void {
    const summed = measure.sumCell(cell);
    const characterPlace = placeOf(
      this.widestCharacters,
      summed.widestCharacterPx,
      SAME_WIDTH_PX,
      KEPT_CELLS,
    );
    if (characterPlace !== undefined) {
      keepCellAt(
        this.widestCharacters,
        characterPlace,
        { index, widthPx: summed.widestCharacterPx },
        SAME_WIDTH_PX,
        KEPT_CELLS,
      );
    }
    const widestSummedPx = Math.max(summed.widestLinePx, this.#lineCandidates[0]?.widthPx ?? 0);
    const lineMarginPx = SAME_WIDTH_PX + SUMMED_ERROR_SHARE * widestSummedPx;
    const linePlace = placeOf(
      this.#lineCandidates,
      summed.widestLinePx,
      lineMarginPx,
      LINE_CANDIDATES,
    );
    if (linePlace !== undefined) {
      keepCellAt(
        this.#lineCandidates,
        linePlace,
        { index, widthPx: summed.widestLinePx, cell, measuredPx: undefined },
        lineMarginPx,
        LINE_CANDIDATES,
      );
    }
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
 * Where among `cells`, widest first, a cell `widthPx` wide goes, after any as wide, when it changes
 * which are kept: it is within `marginPx` of the widest and lands among the first `limit`. Every
 * kept cell is already within the margin of the widest, so a cell landing past `limit` changes
 * nothing.
 */
function placeOf(
  cells: readonly RankedCell[],
  widthPx: number,
  marginPx: number,
  limit: number,
): number | undefined {
  if (widthPx < (cells[0]?.widthPx ?? 0) - marginPx) {
    return undefined;
  }
  let place = 0;
  while (place < cells.length && (cells[place]?.widthPx ?? 0) >= widthPx) {
    place += 1;
  }
  return place < limit ? place : undefined;
}

/**
 * Puts `offered` among `cells` at `place`, from `placeOf`, then keeps at most `limit` of those
 * within `marginPx` of the widest.
 */
function keepCellAt<Cell extends RankedCell>(
  cells: Cell[],
  place: number,
  offered: Cell,
  marginPx: number,
  limit: number,
): void {
  cells.splice(place, 0, offered);
  const narrowestPx = (cells[0]?.widthPx ?? 0) - marginPx;
  let keptCount = 0;
  while (
    keptCount < cells.length &&
    keptCount < limit &&
    (cells[keptCount]?.widthPx ?? 0) >= narrowestPx
  ) {
    keptCount += 1;
  }
  cells.length = keptCount;
}

function bodyRowCountOf(table: Table): number {
  return Math.max(0, table.children.length - 1);
}
