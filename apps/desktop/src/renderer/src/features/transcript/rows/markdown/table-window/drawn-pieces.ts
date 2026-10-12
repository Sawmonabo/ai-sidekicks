// The pieces a long table read in pieces holds for the rows it draws: those rows' pieces, and the
// pieces before and after the rows on screen, so a scroll meets rows already read. A piece let go
// from the pieces' cache is parsed again as it is held, and the rows it holds draw once it lands.

import type { Table } from "mdast";
import type { Range } from "@tanstack/virtual-core";

import type { Unsubscribe } from "#shared/preload-api.js";
import {
  piecedRowsOf,
  type PiecedRows,
  type RowSpan,
} from "#renderer/components/Markdown/parse/pieced-table.js";

/** The pieces one table window holds for the rows it draws. */
export class DrawnPieces {
  readonly #onLanded: () => void;
  /** Each piece held, by its first row, and the table it is held in. */
  readonly #holds = new Map<number, Unsubscribe>();
  #table: Table | undefined;
  #failure: string | undefined;

  /** `onLanded` is told when a piece parsed again lands, after the call that held it returned. */
  public constructor(onLanded: () => void) {
    this.#onLanded = onLanded;
  }

  /** Why a drawn row could not be read, once its piece failed to parse again. */
  public get failure(): string | undefined {
    return this.#failure;
  }

  /**
   * Holds the pieces of `table` that `indexes`, the rows to draw, read, and the pieces before and
   * after the rows on screen in `range`, and lets go of the pieces no longer drawn. A table parsed
   * whole holds nothing.
   */
  public hold(table: Table, indexes: readonly number[], range: Range): void {
    if (table !== this.#table) {
      this.letGo();
      this.#table = table;
    }
    const pieced = piecedRowsOf(table);
    const rowCount = table.children.length - 1;
    if (pieced === undefined || rowCount <= 0) {
      return;
    }
    const spans = new Map<number, RowSpan>();
    const holdPieceOf = (index: number): void => {
      if (index >= 0 && index < rowCount) {
        const span = pieced.pieceSpanOf(index);
        spans.set(span.firstIndex, span);
      }
    };
    for (const index of indexes) {
      holdPieceOf(index);
    }
    holdPieceOf(pieced.pieceSpanOf(Math.max(0, range.startIndex)).firstIndex - 1);
    holdPieceOf(pieced.pieceSpanOf(Math.max(0, range.endIndex)).lastIndex + 1);
    for (const [firstIndex, letGo] of this.#holds) {
      if (!spans.has(firstIndex)) {
        letGo();
        this.#holds.delete(firstIndex);
      }
    }
    for (const [firstIndex, span] of spans) {
      if (!this.#holds.has(firstIndex)) {
        this.#holds.set(firstIndex, this.#holdSpan(pieced, span));
      }
    }
  }

  /** Whether body row `index` of `table` can be drawn now: its piece is read. */
  public isRowRead(table: Table, index: number): boolean {
    return piecedRowsOf(table)?.isRowRead(index) ?? true;
  }

  /** Lets go of every piece held. */
  public letGo(): void {
    for (const letGo of this.#holds.values()) {
      letGo();
    }
    this.#holds.clear();
  }

  #holdSpan(pieced: PiecedRows, span: RowSpan): Unsubscribe {
    let isAsking = true;
    const letGo = pieced.holdRows(span.firstIndex, span.lastIndex, (failure) => {
      this.#failure ??= failure;
      // A piece still kept is read in the render that held it; one parsed again draws later.
      if (!isAsking) {
        this.#onLanded();
      }
    });
    isAsking = false;
    return letGo;
  }
}
