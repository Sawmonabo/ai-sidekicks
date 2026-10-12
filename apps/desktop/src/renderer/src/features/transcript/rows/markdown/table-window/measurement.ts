// One long table's geometry, measured with no read inside a commit and no long task. Its sample
// rows are drawn hidden, then read in the resize observation that follows the browser's own layout
// of them, so reading them lays nothing out; its rows are ranked and their heights estimated a
// slice at a time, each slice a task of its own ending by the wall clock, and a table read in
// pieces a piece at a time, its sample rows held while they are drawn. It ends, in a task of its
// own, with what the table window draws from: the columns automatic layout gives the whole table,
// the cells' type, and every row's height estimated at those columns.

import type { Table, TableRow } from "mdast";

import {
  holdTableRowsRead,
  passRowsInSlices,
} from "#renderer/components/Markdown/parse/table-rows.js";
import { type HeldTableColumns } from "#renderer/components/Markdown/table-offer.js";
import type { Unsubscribe } from "#shared/preload-api.js";
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
  /** Lets go of the sample rows held while they are drawn hidden and the rows are estimated. */
  #letGoOfSampleRows: Unsubscribe | undefined;
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
      this.#fail();
      throw error;
    }
  }

  /** Stops the measurement: no slice works and no change is told after this. */
  public stop(): void {
    this.#isStopped = true;
    this.#letGoOfSampleRows?.();
    this.#letGoOfSampleRows = undefined;
  }

  /**
   * Ranks the rows in slices, then holds the rows holding each column's widest cells and asks for
   * them drawn hidden.
   */
  #rankRows(): void {
    const cellMeasurer = this.#requireCellMeasurer();
    const widestCells = (this.#widestCells ??= new WidestCells(cellMeasurer.measure));
    const table = this.#table;
    this.#run(async () => {
      const isRanked = await passRowsInSlices(
        this.#view,
        table,
        { firstIndex: widestCells.resume(table), lastIndex: bodyRowCountOf(table) - 1 },
        (row, index) => {
          widestCells.rank(index, row);
        },
        () => this.#isStopped,
      );
      if (!isRanked || this.#isStopped) {
        return;
      }
      const sampleRowIndexes = widestCells.sampleRowIndexes();
      if (sampleRowIndexes === undefined) {
        throw new Error("A long table's rows were all passed with some of them unranked.");
      }
      const letGo = await holdTableRowsRead(table, sampleRowIndexes);
      await this.#inTaskOfItsOwn(() => {
        this.#letGoOfSampleRows = letGo;
        this.#frame = { kind: "columns", sampleRowIndexes };
        this.#onChange();
      }, letGo);
    });
  }

  /** Estimates every row's height at `columns` in slices, then holds the geometry. */
  #estimateRows(columns: HeldTableColumns, sampleRowIndexes: readonly number[]): void {
    const cellMeasurer = this.#requireCellMeasurer();
    const rowHeightsPx = new Float32Array(bodyRowCountOf(this.#table));
    this.#run(async () => {
      const isEstimated = await passRowsInSlices(
        this.#view,
        this.#table,
        { firstIndex: 0, lastIndex: rowHeightsPx.length - 1 },
        (row, index) => {
          rowHeightsPx[index] = estimatedRowHeightPx(row, columns, cellMeasurer);
        },
        () => this.#isStopped,
      );
      if (!isEstimated) {
        return;
      }
      await this.#inTaskOfItsOwn(() => {
        this.#letGoOfSampleRows?.();
        this.#letGoOfSampleRows = undefined;
        this.#geometry = { columns, cellType: cellMeasurer.type, rowHeightsPx, sampleRowIndexes };
        this.#onChange();
      });
    });
  }

  /**
   * Runs `work` unless the measurement has stopped, in a task of its own rather than the last
   * slice's; `letGo` is called instead when it has stopped.
   */
  async #inTaskOfItsOwn(work: () => void, letGo?: Unsubscribe): Promise<void> {
    await this.#view.scheduler.postTask(
      () => {
        if (this.#isStopped) {
          letGo?.();
        } else {
          work();
        }
      },
      { priority: "user-visible" },
    );
  }

  /**
   * Runs `work`; work that fails ends the measurement, whoever waits on it is told, and the error
   * goes on to the page.
   */
  #run(work: () => Promise<void>): void {
    void work().catch((error: unknown) => {
      this.#fail();
      throw error;
    });
  }

  #fail(): void {
    this.stop();
    this.#hasFailed = true;
    this.#onChange();
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
  // Counted by hand: `entries()` would make a pair for every cell of every row.
  let columnIndex = 0;
  for (const cell of row.children) {
    const textWidthPx = (columns.widthsPx[columnIndex] ?? 0) - type.cellChromePx;
    textHeightPx = Math.max(textHeightPx, measure.textHeightOf(cell, textWidthPx));
    columnIndex += 1;
  }
  return textHeightPx + type.rowChromePx;
}

function bodyRowCountOf(table: Table): number {
  return Math.max(0, table.children.length - 1);
}
