// Detects a page landing in front of the window. The reference head is the first key of the last
// set shown to this object, never the window's retained head: the cap trims from the oldest end
// while the feed keeps handing over the whole projection, so counting against the retained head
// reports hundreds of rows "inserted" after a prune and pins history over a page that never
// arrived (measured, after a window trimmed 4000 rows to 400: the prune deferral never lifted).

import { countInsertedBefore, type ViewportRow } from "./viewport-snapshot.js";

/** What one reconcile learned about the front of the window. */
export interface HeadInsertionReading {
  /** How many rows arrived in front of the previous set. Zero on a first reconcile. */
  readonly insertedCount: number;
  /**
   * The cursor the window would be cut at while the page is held; `undefined` exactly when
   * nothing grew at the head.
   */
  readonly headRootCursor: string | undefined;
}

/** Remembers the previous set's head key so each reconcile can tell whether a page landed. */
export class HeadInsertion {
  #headKey: string | undefined;

  /** Fold one incoming set in, and answer for it. Advances the remembered head. */
  public read(rows: readonly ViewportRow[]): HeadInsertionReading {
    const insertedCount = countInsertedBefore(rows, this.#headKey);
    const headRow = rows[0];
    this.#headKey = headRow?.key;
    return {
      insertedCount,
      headRootCursor: insertedCount > 0 && headRow !== undefined ? headRow.rootCursor : undefined,
    };
  }
}
