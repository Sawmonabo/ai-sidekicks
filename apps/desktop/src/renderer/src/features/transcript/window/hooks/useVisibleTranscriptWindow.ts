// The rows the viewport holds after the window cap pruned, and the rows the cap took. Find
// searches this window, not the whole log: a jump is performed by the viewport, so a row it does
// not hold would step to nowhere and report success. A streamed update replaces a row's object and
// nothing else, so the split outlives it and only the current row objects are handed on.

import { useMemo, useState } from "react";

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { type ViewportRow } from "../../viewport/snapshot.js";
import { findPositions, holdsSameObjects, partitionByPositions } from "../row-positions.js";
import { NO_ROWS_REMOVED, type TranscriptWindowModel } from "../transcript-window.js";

/** The window the viewport is showing, and what fell outside it. */
export interface VisibleTranscriptWindow {
  /** The projected rows the viewport holds, in log order. */
  readonly rows: readonly TranscriptEventRow[];
  /**
   * Rows the log has and this window does not — what the cap took. They exist, which says nothing
   * about whether earlier rows can be fetched; that is
   * `features/transcript/history/earlier-reader.ts`.
   */
  readonly prunedAwayRows: readonly TranscriptEventRow[];
}

/**
 * Split the window's rows into those the viewport's reconciled snapshot holds and those the cap
 * took. The cap keeps the identity objects it is handed, so a snapshot holding exactly the window's
 * identities took nothing and the window's own `rows` are handed on whole. Otherwise the split is
 * decided again only when the membership of either list moves.
 */
export function useVisibleTranscriptWindow(
  transcriptWindow: TranscriptWindowModel,
  viewportRows: readonly ViewportRow[],
): VisibleTranscriptWindow {
  const [visibleWindowSplit] = useState(() => new VisibleWindowSplit());
  return useMemo(
    () => visibleWindowSplit.split(transcriptWindow, viewportRows),
    [visibleWindowSplit, transcriptWindow, viewportRows],
  );
}

/**
 * The last split, held as the positions of the rows the cap took, which stay right while neither
 * list's membership moves.
 */
class VisibleWindowSplit {
  #splitViewportRows: readonly ViewportRow[] = [];
  #splitHeldRows: readonly ViewportRow[] = [];
  #prunedRowPositions: readonly number[] = [];
  #prunedAwayRows: readonly TranscriptEventRow[] = NO_ROWS_REMOVED;

  public split(
    transcriptWindow: TranscriptWindowModel,
    heldRows: readonly ViewportRow[],
  ): VisibleTranscriptWindow {
    if (holdsSameObjects(heldRows, transcriptWindow.viewportRows)) {
      return { rows: transcriptWindow.rows, prunedAwayRows: NO_ROWS_REMOVED };
    }
    if (
      !holdsSameObjects(transcriptWindow.viewportRows, this.#splitViewportRows) ||
      !holdsSameObjects(heldRows, this.#splitHeldRows)
    ) {
      // By key, not by object: a snapshot taken before the window moved can name a row whose
      // identity the window has since replaced.
      const heldKeys = new Set(heldRows.map((row) => row.key));
      this.#prunedRowPositions = findPositions(
        transcriptWindow.rows,
        (row) => !heldKeys.has(row.id),
      );
      this.#splitViewportRows = transcriptWindow.viewportRows;
      this.#splitHeldRows = heldRows;
    }
    const rows = partitionByPositions(transcriptWindow.rows, this.#prunedRowPositions);
    // Kept while the rows it names are the same objects, so find does not recount the matches
    // beyond the window on a streamed update to a held row.
    if (!holdsSameObjects(rows.removed, this.#prunedAwayRows)) {
      this.#prunedAwayRows = rows.removed;
    }
    return { rows: rows.kept, prunedAwayRows: this.#prunedAwayRows };
  }
}
