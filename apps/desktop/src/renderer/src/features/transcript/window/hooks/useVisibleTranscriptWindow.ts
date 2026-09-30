// The rows the viewport holds after the window cap pruned, and the rows the cap took. Find
// searches this window, not the whole log: a jump is performed by the viewport, so a row it does
// not hold would step to nowhere and report success.

import { useMemo } from "react";

import { type TimelineRow } from "@ai-sidekicks/contracts";

import { type ViewportRow } from "../../viewport/viewport-snapshot.js";
import { type TranscriptWindowModel } from "../transcript-window.js";

/** The window the viewport is showing, and what fell outside it. */
export interface VisibleTranscriptWindow {
  /** The projected rows the viewport holds, in log order. */
  readonly rows: readonly TimelineRow[];
  /** Rows the log has and this window does not — what the cap took. */
  readonly prunedAwayRows: readonly TimelineRow[];
  /**
   * Whether the cap took rows from before this window's head: true exactly when `prunedAwayRows` is
   * non-empty. It says the rows exist, not that they can be fetched; that is
   * `earlier-history-reader.ts`.
   */
  readonly hasEarlierRows: boolean;
  /** The keys the viewport kept: the set the partition is decided by. */
  readonly heldRowKeys: ReadonlySet<string>;
}

/**
 * Split the log's rows into those the viewport's reconciled snapshot holds and those the cap took.
 * Keyed on the snapshot's row array, not the snapshot, which is republished on every scroll; the
 * array changes only on a reconcile. The held rows are a subset of the window's because the cap
 * adopts the array it is handed, so a row not held is one the cap took.
 */
export function useVisibleTranscriptWindow(
  transcriptWindow: TranscriptWindowModel,
  viewportRows: readonly ViewportRow[],
): VisibleTranscriptWindow {
  return useMemo(() => {
    const visibleKeys = new Set(viewportRows.map((row) => row.key));
    const rows: TimelineRow[] = [];
    const prunedAwayRows: TimelineRow[] = [];
    for (const row of transcriptWindow.rows) {
      if (visibleKeys.has(row.id)) {
        rows.push(row);
      } else {
        prunedAwayRows.push(row);
      }
    }
    return {
      rows,
      prunedAwayRows,
      hasEarlierRows: prunedAwayRows.length > 0,
      heldRowKeys: visibleKeys,
    };
  }, [transcriptWindow, viewportRows]);
}
