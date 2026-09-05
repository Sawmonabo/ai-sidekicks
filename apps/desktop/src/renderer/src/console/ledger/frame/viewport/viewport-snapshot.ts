// What a render of the ledger frame is HANDED, what it hands back, and the two
// pure rules that decide between them.
//
// The seam is between the value vocabulary and the wiring. `viewport-controller.ts`
// owns four live objects, three subscriptions, a virtualizer instance and a
// coalescing frame; everything in this file is a value, computable from its
// arguments and holding nothing. A view, the React binding, and this family's door
// all speak the vocabulary below without ever holding the controller — which is why
// the frame's own barrel re-exports a row type from HERE and not from the module
// that wires the objects together.
//
// The two functions are here for the same reason and not as a leftover. Each is a
// rule about the value vocabulary this module owns: one reads a row-key tail, the
// other reads a reading mode and two offsets. Neither touches a field, so neither
// can be tested by driving the controller — they are asserted directly, which is
// the point of moving them out of a private method.

import { type ReadingAnchorState, type RowKeyProjection } from "../measurement/index.js";
import { type LedgerWindowRow, type PruneOutcome } from "./window-cap.js";

/**
 * One row, as the viewport addresses it.
 *
 * The window's own row type under the name the view uses for it — an alias rather
 * than a second declaration, because the viewport and the window must agree about
 * what a row IS or the cap applies to a different set than the list renders.
 */
export type LedgerViewportRow = LedgerWindowRow;

/**
 * The reading state a render draws, which is deliberately not all of it.
 *
 * `anchorPoint` is bookkeeping — where the reader is standing, so a height change
 * beneath them can be undone — and it changes on every pixel of every scroll. It is
 * omitted here because a snapshot that carried it would notify React sixty times a
 * second while somebody was simply scrolling, which is the render this frame's
 * budget and the library's `directDomUpdates` both exist to avoid.
 */
export type LedgerReadingState = Omit<ReadingAnchorState, "anchorPoint">;

/** Everything a render of the viewport needs, in one stable value. */
export interface LedgerViewportSnapshot {
  readonly rows: readonly LedgerViewportRow[];
  readonly rowKeys: readonly string[];
  /** One distinct key per row, and the repeats projecting them cost. */
  readonly keyProjection: RowKeyProjection;
  readonly reading: LedgerReadingState;
  readonly lastPrune: PruneOutcome | undefined;
}

/** What the surrounding surface tells the frame each render. */
export interface LedgerViewportConditions {
  readonly rows: readonly LedgerViewportRow[];
  /** A turn is mid-flight, so prune waits rather than moving rows under a stream. */
  readonly hasActiveTurn: boolean;
  /** The reveal engine still has characters queued for this frame. */
  readonly isRevealDraining: boolean;
}

/**
 * How many rows arrived after the row that used to be last.
 *
 * `undefined` for the tail key means there was no previous window at all, which is
 * zero appended rather than "every row is new": the reading anchor counts rows that
 * arrived UNDER a reader, and a reader who was not there has nothing to be told
 * about. A tail key the retained set no longer holds is likewise zero — the row it
 * named was pruned, so the arithmetic that would follow it has no origin.
 */
export function countAppendedAfter(
  rows: readonly LedgerViewportRow[],
  previousTailKey: string | undefined,
): number {
  if (previousTailKey === undefined) {
    return 0;
  }
  const previousTailIndex = rows.findIndex((row) => row.key === previousTailKey);
  return previousTailIndex < 0 ? 0 : rows.length - previousTailIndex - 1;
}

/**
 * Whether the virtualizer may subtract a measurement's delta from the offset.
 *
 * Two conjuncts, and BOTH are load-bearing:
 *
 *   • The reader is not following. While following, the tail glide already puts
 *     them at the bottom and a compensation would fight it. While reading, holding
 *     the offset across a measurement is exactly the reading anchor's promise, and
 *     the library can keep it a frame earlier than the next reconcile can.
 *   • The measured row sits ENTIRELY above the fold. A row the reader can see is
 *     growing below their eyes, not above them, so subtracting its delta would drag
 *     the viewport down on every frame of a stream — and, because each drag moves
 *     the anchor, would re-enter through the anchor's own change notification and
 *     never settle. Dropping this conjunct is measurable as an unbounded render
 *     loop rather than as a subtle drift.
 */
export function compensatesForGrowth(
  readingMode: LedgerReadingState["mode"],
  rowEndOffsetPx: number,
  scrollOffsetPx: number,
): boolean {
  return readingMode !== "following" && rowEndOffsetPx <= scrollOffsetPx;
}
