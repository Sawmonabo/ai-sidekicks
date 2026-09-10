// The window the VIEWPORT is showing, and what fell outside it.
//
// THE ONE IDEA THIS MODULE OWNS: there are TWO windows, and the difference between
// them is the defect it exists to make unrepresentable.
//
//   • `LedgerWindowModel` is the whole loaded log — everything the subscription
//     delivered and the projection could place.
//   • `VisibleLedgerWindow` is what the viewport is actually showing, after the
//     window cap has pruned. Find searches it, because find offers to JUMP and a
//     jump is performed by the viewport: a control that counted a row the viewport
//     does not hold would step to it and land nowhere, reporting success.
//
// So the rows the structural controls see are read back off the viewport's own
// reconciled snapshot rather than off the log — one window on screen, one window
// searched. What falls outside it is not silently dropped: the rows are counted, and
// the feed says so.

import { useMemo } from "react";

import { type TimelineRow } from "@ai-sidekicks/contracts";

import { type LedgerViewportRow } from "../../frame/index.js";
import { type LedgerWindowModel } from "./ledger-window.js";

/** The window the viewport is showing, and what fell outside it. */
export interface VisibleLedgerWindow {
  /** The projected rows the viewport holds, in log order. */
  readonly rows: readonly TimelineRow[];
  /** Rows the log has and this window does not — what the cap took. */
  readonly prunedAwayRows: readonly TimelineRow[];
  /**
   * Whether rows sit before this window's head — the CLIP, measured rather than
   * declared.
   *
   * True exactly when the cap took something, which is what `prunedAwayRows`
   * records. It was a hard-coded `false` until now, on the reasoning that no
   * registered read pages a session's log backwards — but that reasoning answers a
   * different question. Whether anybody can FETCH earlier rows and whether earlier
   * rows EXIST are two facts, and collapsing them told the find result it had
   * searched a whole log.
   *
   * So the two are separated: this is the FACT, and the offer is somebody else's.
   * The find result's boundary reads this; the act that fetches rows the daemon still
   * holds is `frame/paging/`'s, which asks the producer rather than the cap. The find
   * surface offers none — see `LedgerFeed.tsx`.
   */
  readonly hasEarlierRows: boolean;
  /**
   * The keys the viewport kept.
   *
   * The set this partition is DECIDED by, published rather than re-derived: an
   * id-to-absence classifier asks exactly this question, and rebuilding it from
   * `prunedAwayRows` would be a second expression of the same membership — one that a
   * later edit could leave disagreeing with the pile beside it.
   */
  readonly heldRowKeys: ReadonlySet<string>;
}

/**
 * Project the viewport's reconciled snapshot back into rows, and name what is not
 * in it and why.
 *
 * Keyed on the snapshot's ROW ARRAY rather than on the snapshot, because a
 * snapshot is republished whenever the reading state moves — which is every time
 * somebody scrolls, and re-deriving on a scroll is the render this frame's budget
 * exists to avoid. The row array's identity changes exactly on a reconcile.
 *
 * THE TWO LISTS NEST — `viewportRows ⊆ ledgerWindow.viewportRows` — because the window
 * cap ADOPTS the array it is handed rather than accumulating across ingests. That
 * nesting is what makes the partition below a decision and not a guess: a row the
 * viewport holds is on screen, and a row it does not is one the cap took.
 */
export function useVisibleLedgerWindow(
  ledgerWindow: LedgerWindowModel,
  viewportRows: readonly LedgerViewportRow[],
): VisibleLedgerWindow {
  return useMemo(() => {
    const visibleKeys = new Set(viewportRows.map((row) => row.key));
    const rows: TimelineRow[] = [];
    const prunedAwayRows: TimelineRow[] = [];
    for (const row of ledgerWindow.rows) {
      if (visibleKeys.has(row.id)) {
        rows.push(row);
      } else {
        prunedAwayRows.push(row);
      }
    }
    return {
      rows,
      prunedAwayRows,
      // One measurement, read by find, so nothing can disagree with it about whether
      // this window is the whole session.
      hasEarlierRows: prunedAwayRows.length > 0,
      heldRowKeys: visibleKeys,
    };
  }, [ledgerWindow, viewportRows]);
}
