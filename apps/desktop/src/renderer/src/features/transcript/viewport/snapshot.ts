// The values a render of the transcript frame is handed and hands back, plus two pure rules on
// them. Nothing here holds state, so views and the React binding import the row type from here
// without holding the controller, and the rules are tested directly.

import { type ReadingAnchorState } from "./reading-anchor.js";
import { type RowKeyProjection } from "./row-measurement-table.js";
import { type WindowRow, type PruneOutcome } from "./window-cap.js";

/**
 * One row, as the viewport addresses it. An alias of the window's row type, so the window and the
 * list agree on what a row is.
 */
export type ViewportRow = WindowRow;

/**
 * The reading state a render draws. `anchorPoint` is omitted: it changes on every scrolled pixel
 * and would notify React sixty times a second.
 */
export type ReadingState = Omit<ReadingAnchorState, "anchorPoint">;

/** Everything a render of the viewport needs, in one stable value. */
export interface ViewportSnapshot {
  readonly rows: readonly ViewportRow[];
  readonly rowKeys: readonly string[];
  /** One distinct key per row, and the repeats projecting them cost. */
  readonly keyProjection: RowKeyProjection;
  readonly reading: ReadingState;
  readonly lastPrune: PruneOutcome | undefined;
}

/** What the surrounding feed tells the frame each render. */
export interface ViewportConditions {
  readonly rows: readonly ViewportRow[];
  /** A turn is mid-flight, so a cut waits rather than moving rows under a stream. */
  readonly hasActiveTurn: boolean;
  /** The reveal engine still has characters queued for this frame. */
  readonly isRevealDraining: boolean;
}

/**
 * How many rows arrived after the row that used to be last.
 *
 * Zero when there was no previous set or its last row is gone: nothing is owed to a reader who
 * was not there, and a vanished key has no origin to count from.
 */
export function countAppendedAfter(
  rows: readonly ViewportRow[],
  previousTailKey: string | undefined,
): number {
  if (previousTailKey === undefined) {
    return 0;
  }
  const previousTailIndex = rows.findIndex((row) => row.key === previousTailKey);
  return previousTailIndex < 0 ? 0 : rows.length - previousTailIndex - 1;
}

/**
 * How many rows arrived before the row that used to be first; the mirror of
 * {@link countAppendedAfter}. Appended rows arrive under a reader and feed the tail pill;
 * inserted rows arrive above one, and the frame undoes the shift they cause. Zero for the same
 * reasons: no previous window, or a head key the incoming set no longer carries.
 */
export function countInsertedBefore(
  rows: readonly ViewportRow[],
  previousHeadKey: string | undefined,
): number {
  if (previousHeadKey === undefined) {
    return 0;
  }
  const previousHeadIndex = rows.findIndex((row) => row.key === previousHeadKey);
  return previousHeadIndex < 0 ? 0 : previousHeadIndex;
}

/**
 * Whether the virtualizer may subtract a measurement's delta from the offset: only when the
 * reader is not following (the library's end anchor already holds a follower on the tail) and the
 * measured row sits entirely above the fold. A visible row grows below the reader's eyes, and compensating for it would
 * drag the viewport every frame of a stream and loop through the anchor's change notification.
 */
export function shouldCompensateForInsertion(
  readingMode: ReadingState["mode"],
  rowEndOffsetPx: number,
  scrollOffsetPx: number,
): boolean {
  return readingMode !== "following" && rowEndOffsetPx <= scrollOffsetPx;
}
