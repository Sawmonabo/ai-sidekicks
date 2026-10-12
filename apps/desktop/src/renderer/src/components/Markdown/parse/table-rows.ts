// A table's body rows as a reader reads them, whether the table is read in pieces or parsed whole:
// handed in order while they can be read, held before they are read, and passed a slice at a time,
// a piece held at a time, so a pass over a long table holds no more than the piece it reads and the
// one after it, which is parsed while the first is read.

import type { Table, TableRow } from "mdast";

import { workInSlices } from "#renderer/lib/work-slices.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { piecedRowsOf, type RowSpan } from "./pieced-table.js";

/**
 * Hands `visit` the body rows of `table` from `firstIndex` to `lastIndex` that can be read now, in
 * order, while it answers true, and answers the first index it was not handed.
 */
export function passTableRows(
  table: Table,
  firstIndex: number,
  lastIndex: number,
  visit: (row: TableRow, index: number) => boolean,
): number {
  const pieced = piecedRowsOf(table);
  if (pieced !== undefined) {
    return pieced.passRows(firstIndex, lastIndex, visit);
  }
  const last = Math.min(lastIndex, table.children.length - 2);
  for (let index = firstIndex; index <= last; index += 1) {
    const row = table.children[index + 1];
    if (row === undefined || !visit(row, index)) {
      return row === undefined ? index : index + 1;
    }
  }
  return Math.max(firstIndex, last + 1);
}

/**
 * Keeps body rows `firstIndex` to `lastIndex` of `table` readable until the returned call lets
 * them go, and calls `onRead` once they are, before returning when they already are; or with why
 * they could not be. A table parsed whole holds every row already.
 */
export function holdTableRows(
  table: Table,
  firstIndex: number,
  lastIndex: number,
  onRead: (failure: string | undefined) => void,
): Unsubscribe {
  const pieced = piecedRowsOf(table);
  if (pieced === undefined) {
    onRead(undefined);
    return NO_HOLD;
  }
  return pieced.holdRows(firstIndex, lastIndex, onRead);
}

/**
 * Holds body rows `indexes` of `table` and resolves with what lets them go once every one can be
 * read; rejects with why one could not be, having let them all go.
 */
export async function holdTableRowsRead(
  table: Table,
  indexes: readonly number[],
): Promise<Unsubscribe> {
  const holds = indexes.map(
    (index) => new HeldRows(table, { firstIndex: index, lastIndex: index }),
  );
  const letGo: Unsubscribe = () => {
    for (const hold of holds) {
      hold.letGo();
    }
  };
  try {
    for (const hold of holds) {
      await hold.whenRead();
    }
  } catch (error: unknown) {
    letGo();
    throw error;
  }
  return letGo;
}

/**
 * Hands `visit` every body row of `table` in `span`, in order, a slice at a time in `view`. Resolves
 * `true` once every row is handed, or `false` when `isStopped` answers true before a slice; rejects
 * with why a piece could not be parsed again, or with what `visit` threw.
 */
export async function passRowsInSlices(
  view: Window,
  table: Table,
  span: RowSpan,
  visit: (row: TableRow, index: number) => void,
  isStopped: () => boolean,
): Promise<boolean> {
  const rowCount = Math.min(span.lastIndex + 1, Math.max(0, table.children.length - 1));
  let nextIndex = span.firstIndex;
  const passTo = async (lastIndex: number): Promise<boolean> =>
    await workInSlices(
      view,
      (hasTime) => {
        nextIndex = passTableRows(table, nextIndex, lastIndex, (row, index) => {
          visit(row, index);
          return hasTime();
        });
        return nextIndex > lastIndex;
      },
      isStopped,
    );
  const pieced = piecedRowsOf(table);
  if (pieced === undefined) {
    return nextIndex >= rowCount || (await passTo(rowCount - 1));
  }
  const holdPieceOf = (index: number): HeldRows | undefined =>
    index < rowCount ? new HeldRows(table, pieced.pieceSpanOf(index)) : undefined;
  let held = holdPieceOf(nextIndex);
  try {
    while (held !== undefined) {
      await held.whenRead();
      const current = held;
      held = holdPieceOf(current.span.lastIndex + 1);
      const isPassed = await passTo(Math.min(current.span.lastIndex, rowCount - 1));
      current.letGo();
      if (!isPassed) {
        return false;
      }
    }
    return true;
  } finally {
    held?.letGo();
  }
}

/** Holds nothing: every row of a table parsed whole is read. */
const NO_HOLD: Unsubscribe = () => undefined;

/** A run of a table's rows held, and whether they can be read yet. */
class HeldRows {
  public readonly span: RowSpan;
  readonly #letGo: Unsubscribe;
  #isRead = false;
  #failure: string | undefined;
  #wake: (() => void) | undefined;

  public constructor(table: Table, span: RowSpan) {
    this.span = span;
    this.#letGo = holdTableRows(table, span.firstIndex, span.lastIndex, (failure) => {
      this.#isRead = failure === undefined;
      this.#failure = failure;
      this.#wake?.();
    });
  }

  /** Resolves once the rows can be read; rejects with why they could not be. */
  public async whenRead(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const settle = (): void => {
        if (this.#failure !== undefined) {
          reject(new Error(this.#failure));
        } else if (this.#isRead) {
          resolve();
        }
      };
      this.#wake = settle;
      settle();
    });
  }

  public letGo(): void {
    this.#letGo();
  }
}
