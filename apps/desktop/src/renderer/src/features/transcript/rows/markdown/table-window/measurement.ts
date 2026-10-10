// One long table's geometry, measured with no read inside a commit and no long task. Its sample
// rows are drawn hidden, then read in the resize observation that follows the browser's own layout
// of them, so reading them lays nothing out; its rows are ranked and their heights estimated a
// slice at a time, each slice a task of its own ending by the wall clock. It ends, in a task of its
// own, with what the table window draws from: the columns automatic layout gives the whole table,
// the cells' type, and every row's height estimated at those columns.

import type { Table, TableRow } from "mdast";

import { type HeldTableColumns } from "#renderer/components/Markdown/table-offer.js";
import { workInSlices } from "#renderer/lib/work-slices.js";
import { TableCellMeasure, readTableCellType, type TableCellType } from "./cell-measure.js";
import { type TableGeometry } from "./geometry-memory.js";
import { measureTableColumns } from "./measured-columns.js";
import { WidestCells } from "./widest-cells.js";

/**
 * What a measurement needs drawn hidden, as the table's cells draw: a row of each inline kind,
 * whose fonts rank the rows; then the head and the body rows holding each column's widest cells,
 * in automatic layout.
 */
export type TableMeasuringFrame =
  | { readonly kind: "cell-type" }
  | { readonly kind: "columns"; readonly sampleRowIndexes: readonly number[] };

/** The cells' type, and their text measured in it. */
export interface TableCellMeasurer {
  readonly type: TableCellType;
  readonly measure: TableCellMeasure;
}

/**
 * Measures one table as it stood when the measurement began. `onChange` is called when the frame
 * to draw hidden changes, when the geometry is ready and when a frame could not be read. Throws
 * for a document with no window.
 */
export class TableMeasurement {
  readonly #table: Table;
  readonly #ownerDocument: Document;
  readonly #view: Window;
  readonly #onChange: () => void;
  #cellMeasurer: TableCellMeasurer | undefined;
  #widestCells: WidestCells | undefined;
  #frame: TableMeasuringFrame | undefined;
  #geometry: TableGeometry | undefined;
  #isStopped = false;
  #hasFailed = false;

  /**
   * Starts measuring `table` in `ownerDocument`, its own: a window's fonts load in its document
   * alone. With the cells' type already read, and the rows ranked so far, it starts from them.
   */
  public constructor(
    table: Table,
    ownerDocument: Document,
    onChange: () => void,
    known?: { readonly cellMeasurer: TableCellMeasurer; readonly widestCells?: WidestCells },
  ) {
    const view = ownerDocument.defaultView;
    if (view === null) {
      throw new Error("A long table was measured in a document with no window.");
    }
    this.#table = table;
    this.#ownerDocument = ownerDocument;
    this.#view = view;
    this.#onChange = onChange;
    if (known === undefined) {
      this.#frame = { kind: "cell-type" };
      return;
    }
    this.#cellMeasurer = known.cellMeasurer;
    this.#widestCells = known.widestCells;
    this.#rankRows();
  }

  /** The table this measures, as it stood when it began. */
  public get table(): Table {
    return this.#table;
  }

  /** What to draw hidden for the measurement now, or `undefined` while it works in slices. */
  public get frame(): TableMeasuringFrame | undefined {
    return this.#frame;
  }

  /** Whether a hidden frame could not be read, which ends the measurement with no geometry. */
  public get hasFailed(): boolean {
    return this.#hasFailed;
  }

  /** The geometry measured, once it is ready. */
  public get geometry(): TableGeometry | undefined {
    return this.#geometry;
  }

  /** The cells' type and the rows' ranking, once read, for the measurement that follows. */
  public get known():
    | { readonly cellMeasurer: TableCellMeasurer; readonly widestCells: WidestCells }
    | undefined {
    const cellMeasurer = this.#cellMeasurer;
    const widestCells = this.#widestCells;
    return cellMeasurer === undefined || widestCells === undefined
      ? undefined
      : { cellMeasurer, widestCells };
  }

  /**
   * Reads the frame drawn for `frame` from `table`, the hidden table it was drawn in, once the
   * browser has laid it out. A frame read twice, or read after the measurement moved on, is read
   * once.
   */
  public readFrame(frame: TableMeasuringFrame, table: HTMLTableElement): void {
    if (this.#isStopped || frame !== this.#frame) {
      return;
    }
    this.#frame = undefined;
    try {
      if (frame.kind === "cell-type") {
        const type = readTableCellType(table);
        this.#cellMeasurer = { type, measure: new TableCellMeasure(type, this.#ownerDocument) };
        this.#rankRows();
        return;
      }
      this.#estimateRows(measureTableColumns(table), frame.sampleRowIndexes);
    } catch (error) {
      // A frame that cannot be read ends the measurement: whoever waits on it is told, and the
      // error goes on to the page.
      this.stop();
      this.#hasFailed = true;
      this.#onChange();
      throw error;
    }
  }

  /** Stops the measurement: no slice works and no change is told after this. */
  public stop(): void {
    this.#isStopped = true;
  }

  /** Ranks the rows in slices, then asks for the rows holding each column's widest cells. */
  #rankRows(): void {
    const cellMeasurer = this.#requireCellMeasurer();
    const widestCells = (this.#widestCells ??= new WidestCells(cellMeasurer.measure));
    this.#workInSlices(
      (hasTime) => widestCells.rank(this.#table, hasTime),
      () => {
        this.#frame = {
          kind: "columns",
          sampleRowIndexes: widestCells.sampleRowIndexes(this.#table),
        };
        this.#onChange();
      },
    );
  }

  /** Estimates every row's height at `columns` in slices, then holds the geometry. */
  #estimateRows(columns: HeldTableColumns, sampleRowIndexes: readonly number[]): void {
    const cellMeasurer = this.#requireCellMeasurer();
    const rowCount = Math.max(0, this.#table.children.length - 1);
    const rowHeightsPx = new Float32Array(rowCount);
    let nextIndex = 0;
    this.#workInSlices(
      (hasTime) => {
        while (nextIndex < rowCount && hasTime()) {
          const row = this.#table.children[nextIndex + 1];
          rowHeightsPx[nextIndex] =
            row === undefined ? 0 : estimatedRowHeightPx(row, columns, cellMeasurer);
          nextIndex += 1;
        }
        return nextIndex >= rowCount;
      },
      () => {
        this.#geometry = { columns, cellType: cellMeasurer.type, rowHeightsPx, sampleRowIndexes };
        this.#onChange();
      },
    );
  }

  /**
   * Runs `work` a slice at a time until it answers it is done, then `done` in a task of its own,
   * not the last slice's, unless the measurement stops first. A slice that throws rejects the
   * work, so the error reaches the page.
   */
  #workInSlices(work: (hasTime: () => boolean) => boolean, done: () => void): void {
    const view = this.#view;
    void workInSlices(view, work, () => this.#isStopped).then(async (isDone) => {
      if (!isDone) {
        return;
      }
      await view.scheduler.postTask(
        () => {
          if (!this.#isStopped) {
            done();
          }
        },
        { priority: "user-visible" },
      );
    });
  }

  #requireCellMeasurer(): TableCellMeasurer {
    const cellMeasurer = this.#cellMeasurer;
    if (cellMeasurer === undefined) {
      throw new Error("A long table's rows were measured before its cells' type was read.");
    }
    return cellMeasurer;
  }
}

/**
 * The room `row` takes with its cells' text wrapped at `columns` in the cells' fonts: its tallest
 * cell's text, a line at least, and the row's box.
 */
export function estimatedRowHeightPx(
  row: TableRow,
  columns: HeldTableColumns,
  { type, measure }: TableCellMeasurer,
): number {
  let textHeightPx = type.lineHeightsPx.plain;
  for (const [columnIndex, cell] of row.children.entries()) {
    const textWidthPx = (columns.widthsPx[columnIndex] ?? 0) - type.cellChromePx;
    textHeightPx = Math.max(textHeightPx, measure.textHeightOf(cell, textWidthPx));
  }
  return textHeightPx + type.rowChromePx;
}
