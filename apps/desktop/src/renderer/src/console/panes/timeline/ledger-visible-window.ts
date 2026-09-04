// The window the VIEWPORT is showing, what fell outside it, and the rail's two
// fractions over it.
//
// THE ONE IDEA THIS MODULE OWNS: there are TWO windows, and the difference between
// them is the defect it exists to make unrepresentable.
//
//   • `LedgerWindowModel` is the whole loaded log — everything the subscription
//     delivered and the projection could place. Replay plays over it, because
//     `Spec-023 §Console Design (Meridian)` replays "the rows already loaded".
//   • `VisibleLedgerWindow` is what the viewport is actually showing, after the
//     window cap has pruned and after replay has withheld whatever the position has
//     not reached. Find searches it and the rail marks it, because both of them
//     offer to JUMP, and a jump is performed by the viewport: a control that
//     counted a row the viewport does not hold would step to it and land nowhere,
//     reporting success.
//
// So the rows the two structural controls see are read back off the viewport's own
// reconciled snapshot rather than off the log — one window on screen, one window
// searched, one window marked. What falls outside it is not silently dropped: the
// rows are counted, and the feed says so.
//
// AND THE ROWS OUTSIDE IT ARE COUNTED IN TWO PILES, NOT ONE. Cap retention and
// replay visibility are two facts about a row, and this module tracks them
// separately because a person's next move differs: a row the cap took is gone until
// the session is read again, and a row the replay position has not reached comes
// back the moment the dock is scrubbed forward. One complement over the viewport's
// rows reported every not-yet-replayed row as an older entry the cap had removed,
// which is wrong twice — those rows are NEWER than the window's head, and nothing
// removed them.
//
// THE RAIL'S GEOMETRY LIVES HERE TOO, and it is the same subject rather than a
// second one: both readings are measurements of the box, taken off the binding's
// own `visibleRange`, and a rail sized from one window while it marks another is
// exactly the disagreement this module exists to prevent.

import { useMemo } from "react";

import { type TimelineRow } from "@ai-sidekicks/contracts";

import { type LedgerViewportRow } from "../../ledger/frame/index.js";
// The frame's door carries the four symbols a stranger holds; this range is the
// binding's own shape, reached by module path the way this family's other subtrees
// reach the frame's internals.
import { type LedgerVisibleRowRange } from "../../ledger/frame/viewport-binding.js";
import {
  ProvenanceRailModel,
  railViewportBand,
  type RailViewportBand,
} from "../../ledger/structure/index.js";
import { type LedgerWindowModel } from "./ledger-window.js";

/** The window the viewport is showing, and what fell outside it. */
export interface VisibleLedgerWindow {
  /** The projected rows the viewport holds, in log order. */
  readonly rows: readonly TimelineRow[];
  /** Rows the log has and this window does not — what the cap took. */
  readonly prunedAwayRows: readonly TimelineRow[];
  /**
   * Rows the log has and the replay position has not reached yet.
   *
   * A separate pile from `prunedAwayRows` because the two absences are different
   * facts, and the difference is the whole point: nothing removed these rows, they
   * are newer rather than older, and scrubbing the dock forward brings them back.
   */
  readonly withheldByReplayRows: readonly TimelineRow[];
  /**
   * Whether rows sit before this window's head — the CLIP, measured rather than
   * declared.
   *
   * True exactly when the cap took something, which is what `prunedAwayRows`
   * records — and deliberately NOT when replay is merely holding rows back, which
   * would draw an unloaded segment over a complete window and make find state a
   * boundary that is not there. It was a hard-coded `false` until now, on the
   * reasoning that no registered read pages a session's log backwards — but that
   * reasoning answers a different question. Whether anybody can FETCH earlier rows
   * and whether earlier
   * rows EXIST are two facts, and collapsing them made the rail draw a complete
   * session over a window the cap had already truncated, and told the find result
   * it had searched a whole log.
   *
   * So the two are separated: this is the fact, and an absent `onLoadEarlier`
   * handler is the offer. The rail's dotted segment and the find result's boundary
   * read the fact; the "load earlier" button reads both, which is why it is never
   * drawn on this build.
   */
  readonly hasEarlierRows: boolean;
  /** The rail's derivation over the rows on screen. */
  readonly railModel: ProvenanceRailModel;
}

/**
 * Project the viewport's reconciled snapshot back into rows, and name what is not
 * in it and why.
 *
 * Keyed on the snapshot's ROW ARRAY rather than on the snapshot, because a
 * snapshot is republished whenever the reading state moves — which is every time
 * somebody scrolls, and re-deriving the rail on a scroll is the render this frame's
 * budget exists to avoid. The row array's identity changes exactly on a reconcile.
 *
 * THE THREE LISTS NEST — `viewportRows ⊆ revealedRows ⊆ ledgerWindow.viewportRows`
 * — because the window cap ADOPTS the array it is handed rather than accumulating
 * across ingests, so whatever replay withheld the cap never saw. That nesting is
 * what makes the partition below a decision and not a guess: a row the viewport
 * holds is on screen, a row only the revealed set holds is one the cap took, and a
 * row neither holds is one the replay position has not reached.
 */
export function useVisibleLedgerWindow(
  ledgerWindow: LedgerWindowModel,
  revealedRows: readonly LedgerViewportRow[],
  viewportRows: readonly LedgerViewportRow[],
): VisibleLedgerWindow {
  return useMemo(() => {
    const visibleKeys = new Set(viewportRows.map((row) => row.key));
    const revealedKeys = new Set(revealedRows.map((row) => row.key));
    const rows: TimelineRow[] = [];
    const prunedAwayRows: TimelineRow[] = [];
    const withheldByReplayRows: TimelineRow[] = [];
    for (const row of ledgerWindow.rows) {
      if (visibleKeys.has(row.id)) {
        rows.push(row);
      } else if (revealedKeys.has(row.id)) {
        prunedAwayRows.push(row);
      } else {
        withheldByReplayRows.push(row);
      }
    }
    // One measurement, read by the rail and by find, so the two can never disagree
    // about whether this window is the whole session.
    const hasEarlierRows = prunedAwayRows.length > 0;
    return {
      rows,
      prunedAwayRows,
      withheldByReplayRows,
      hasEarlierRows,
      // THE ROW ORDERING, not the rows. `useRailGeometry` sizes the thumb by index
      // into this same list, so handing the rail anything else would put the marks
      // on one axis and the thumb on another — and this list is the one that
      // carries a folded chapter's header, which owns a band and takes no mark.
      railModel: new ProvenanceRailModel({
        rows,
        retainedRowKeys: viewportRows.map((row) => row.key),
        hasEarlierRows,
      }),
    };
  }, [ledgerWindow, revealedRows, viewportRows]);
}

/**
 * The rail's thumb, in ROW space.
 *
 * Row space rather than pixel space because that is the space the rail lays its own
 * marks out in: a tick sits at its row's place in the window, so a thumb measured in
 * pixels would drift away from the marks it is supposed to point at wherever rows
 * differ in height — which, with tool cards and streamed prose in the same log, is
 * everywhere.
 *
 * The arithmetic itself is `rail-model.ts`'s row-band model and is not restated
 * here. That is the whole point of the seam: the marks and the thumb are placed by
 * ONE function of one ordering, so a thumb that no longer contains the marks under
 * it is not a shape this pair can take. `rowCount` is the retained viewport row
 * count — the same ordering the rail model is handed, headers included — and the
 * indices are positions in it.
 *
 * Measured off the binding's `visibleRange` and NOT off `virtualItems`, which is
 * that range widened by the overscan at both edges: at the estimated row height a
 * 400px box intersects about five rows and mounts about seventeen, so a thumb sized
 * off the mount range is more than three times too tall and starts six rows early —
 * a thumb that no longer points at the ticks under it. An absent range is a box
 * nothing has measured, and the honest answer for one is the whole rail.
 */
export function useRailGeometry(
  visibleRange: LedgerVisibleRowRange | undefined,
  rowCount: number,
): RailViewportBand {
  const firstIndex = visibleRange?.startIndex;
  const lastIndex = visibleRange?.endIndex;
  return useMemo(() => {
    if (firstIndex === undefined || lastIndex === undefined) {
      return { position: 0, extent: 1 };
    }
    return railViewportBand(firstIndex, lastIndex, rowCount);
    // The two indices rather than the range object: the virtualizer recomputes that
    // object whenever the scroll offset moves, so keying on its identity would
    // re-derive the geometry on scrolls that did not change which rows are on
    // screen.
  }, [firstIndex, lastIndex, rowCount]);
}
