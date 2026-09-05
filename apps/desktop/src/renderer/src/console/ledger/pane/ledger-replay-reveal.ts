// Stage two's second half: what a replay POSITION lets the viewport draw.
//
// Split from the walk beside it because the two answer different questions with
// different instruments. `ledger-replay-window.ts` owns the walk — which rows one
// replay is over, when that set is frozen, and the engine's lifetime — and everything
// here is a pure derivation over a window and a position, driven with no clock, no
// engine, and no mount at all.

import { useMemo } from "react";

import { type LedgerViewportRow } from "../frame/index.js";
// The frame's door carries the four symbols a stranger holds; this range is the
// binding's own shape, reached by module path the way this family's other subtrees
// reach the frame's internals.
import { type LedgerVisibleRowRange } from "../frame/viewport-binding.js";
import { type ReplayPosition, type ReplayState } from "../structure/index.js";
import { type LedgerWindowModel } from "./ledger-window.js";

/**
 * The row a "replay from here" starts at — the one at the top of the box.
 *
 * WHY THE VIEWPORT AND NOT A ROW CONTROL. "Here" is a row, and the row a person
 * means is the one they are looking at. A per-row button would say it more
 * directly, and this console cannot draw one: a row's body is the timeline row
 * seat's, whose props are the row and three list decisions with no callback among
 * them, and the seat belongs to another plan. So the anchor is read from the
 * surface this family does own — the range the virtualizer reports the box
 * intersects, off the same reading `useRailGeometry` sizes the rail's thumb from.
 *
 * FIRST VISIBLE, not the middle or the last: the first row is the one under the
 * reader's eye at the top edge, and it is the row a scroll position names.
 *
 * `undefined` for a box nothing has measured or a window with no rows — which the
 * act refuses on rather than substituting the window's head, because replaying from
 * the beginning is a different act with its own control on the dock.
 */
export function useReplayAnchorRowId(
  visibleRange: LedgerVisibleRowRange | undefined,
  viewportRows: readonly LedgerViewportRow[],
): string | undefined {
  const firstIndex = visibleRange?.startIndex;
  return useMemo(
    () => (firstIndex === undefined ? undefined : viewportRows[firstIndex]?.key),
    [firstIndex, viewportRows],
  );
}

/**
 * Whether replay is holding the window back.
 *
 * Derived from the state union rather than restated as a second enumeration, and
 * `idle` is the only arm that is not engaged: an idle replay sits at elapsed zero,
 * where the revealed set is the rows that share the window's first instant, so
 * treating it as engaged would hide the whole session behind a control nobody had
 * touched.
 */
export function isReplayEngaged(state: ReplayState): boolean {
  return state !== "idle";
}

/**
 * The rows a replay has reached, in the log's own order.
 *
 * A FILTER over the window's own identity list, never a re-ordering of it. The
 * engine orders by `occurredAt` because that is what replay plays in, and the ledger
 * renders in wire order; sorting the viewport by the engine's order would make a
 * replay silently rearrange a log wherever the daemon admitted rows out of
 * wall-clock order.
 *
 * TWO KINDS OF ROW, AND ONLY ONE OF THEM IS ON THE REPLAY CLOCK. The engine is
 * built from projected rows, so `revealedRowIds` holds event-row ids and nothing
 * else — while a chapter header's viewport key is its RUN id, which is in that set
 * at no position at all. Tested against it, every synthetic header was stripped at
 * every position including `at-tail`, and a folded chapter's receipt came through
 * without it: the disclosure that names the run and reopens it was gone, and the
 * receipt hung under a parent the window no longer held, which the cap reads as a
 * top-level row rather than as the chapter's child.
 *
 * SO A HEADER IS ADMITTED WHEN ITS CHAPTER HAS REACHED THE POSITION, and reached is
 * defined from the model rather than from the clock: at least one of the chapter's
 * rows THIS WINDOW HOLDS is revealed. Two properties follow, and both are why this
 * definition and not one over the chapter's first row or its run's start instant:
 *
 *   • `at-tail` renders exactly what an unreplayed ledger renders. Every held row
 *     is revealed there, every chapter holds at least one — a folded one keeps its
 *     receipt, an open one keeps its rows — so every header is admitted.
 *   • A header and its chapter appear and disappear together. There is no position
 *     at which a header stands over nothing, and none at which a member row hangs
 *     off a header the window has dropped. For a folded chapter that means header
 *     and receipt arrive in the same instant the run ended, which is also the only
 *     honest moment for a header that renders the terminal's own name.
 *
 * While replay is idle the window's own array is returned by identity, so the
 * viewport does not reconcile and a ledger nobody is replaying pays nothing.
 */
export function useReplayRevealedRows(
  ledgerWindow: LedgerWindowModel,
  position: ReplayPosition,
): readonly LedgerViewportRow[] {
  return useMemo(() => {
    if (!isReplayEngaged(position.state)) {
      return ledgerWindow.viewportRows;
    }
    const revealedRowIds = new Set(position.revealedRowIds);
    const reachedChapterRunIds = new Set<string>();
    for (const row of ledgerWindow.viewportRows) {
      if (row.parentKey !== undefined && revealedRowIds.has(row.key)) {
        reachedChapterRunIds.add(row.parentKey);
      }
    }
    return ledgerWindow.viewportRows.filter((row) =>
      // The same lookup the feed's row renderer dispatches on, so "is this a header"
      // is one classification rather than a second guess at what a key means.
      ledgerWindow.chapterByHeaderKey.has(row.key)
        ? reachedChapterRunIds.has(row.key)
        : revealedRowIds.has(row.key),
    );
  }, [ledgerWindow, position]);
}
