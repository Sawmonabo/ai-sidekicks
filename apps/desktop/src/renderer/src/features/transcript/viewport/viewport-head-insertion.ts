// Did a page land in FRONT of this window, and where would it be cut?
//
// One question, asked once per reconcile, and it needs one remembered fact to answer
// — which is why it is a small object and not a second pure rule beside
// `countInsertedBefore`. That function counts rows before a key somebody names; this
// decides WHICH key to name, and getting that wrong is not a subtle drift.
//
// THE KEY IS THE LAST SET THIS OBJECT WAS SHOWN, NEVER THE ONE THE WINDOW RETAINED.
// The window's cap trims from the oldest end and the surrounding surface keeps
// handing over the whole projection, so after a single prune the retained head sits
// in the middle of every later set. Counted against that, an ordinary reconcile
// reports hundreds of rows "inserted before the head" and the caller pins history
// over a page that never arrived — measured, on a window that had trimmed 4000 rows
// to 400, as a prune deferral that never lifts again for the life of the session.
//
// Counted against the incoming head, the same trim reports zero: the rows the cap
// took are still at the front of what arrives, and the answer is honest in both
// directions.

import { countInsertedBefore, type LedgerViewportRow } from "./viewport-snapshot.js";

/** What one reconcile learned about the front of the window. */
export interface LedgerHeadGrowthReading {
  /** How many rows arrived in front of the previous set. Zero on a first reconcile. */
  readonly insertedCount: number;
  /**
   * The cursor the window would be cut at while the page is held, where one grew.
   *
   * `undefined` exactly when nothing grew at the head. A growth always has a head row
   * and every row carries a root cursor, so the two members move together — the union
   * is here to make "nothing arrived" unrepresentable as a cursor rather than to
   * describe a row the pin could not name.
   */
  readonly headRootCursor: string | undefined;
}

export class LedgerHeadGrowth {
  #headKey: string | undefined;

  /** Fold one incoming set in, and answer for it. Advances the remembered head. */
  public read(rows: readonly LedgerViewportRow[]): LedgerHeadGrowthReading {
    const insertedCount = countInsertedBefore(rows, this.#headKey);
    const headRow = rows[0];
    this.#headKey = headRow?.key;
    return {
      insertedCount,
      // The `headRow` conjunct narrows rather than guards: a count above zero is an
      // index into this array, so the row is there whenever the cursor is asked for.
      headRootCursor: insertedCount > 0 && headRow !== undefined ? headRow.rootCursor : undefined,
    };
  }
}
