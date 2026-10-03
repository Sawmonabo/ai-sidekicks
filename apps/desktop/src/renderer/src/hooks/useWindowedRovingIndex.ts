// Where a windowed list's keyboard is, and how the moved-to row is found once it mounts.
//
// A window mounts only some rows and Tab reaches only what is mounted, so one row is the tab
// stop (the WAI-ARIA roving tabindex) and the arrows move which. The key handler records
// where focus is going and an effect takes it there on whichever render the row arrives on.
//
// The focus target is declared, never discovered: `WindowedListRow` marks one element per row
// (the attribute `windowed-row-markers.ts` owns) and writes the roving `tabIndex` on it. A
// selector would match the wrapper first and leave descendants in the page's tab order.
//
// The active index is clamped to the current set, so narrowing a list from 39 rows to five
// does not leave every row untabbable. A clamp cannot say which row a remembered move now
// names, so a caller with a filtered, sorted or re-fetched set states `rowSetIdentity`, and a
// move made under a different one is dropped in favor of the anchor. That is separate from
// `windowRevision`, which changes on every scroll (and every render, from a virtualizer).
//
// Focus is only taken, never given back, and the claim expires. Only the key handler arms it;
// it holds the move and a budget of effect runs and is consumed once. It is dropped when the
// index now names a different row, when the sequence was redrawn, or when the budget is
// spent, so a later unrelated update cannot pull focus from wherever the reader has tabbed.
// The budget counts this hook's own runs because a virtualizer's fresh array every render
// would spend a `windowRevision` comparison before the reveal could answer.
//
// The anchor is revealed once per index through `revealIndex`, and until it mounts the
// nearest mounted row holds the stop, so a list reopened on an unmounted selection stays
// reachable. The focus claim still names the row the key asked for.
//
// A move that goes nowhere (`End` on the last row) arms nothing, since no run would spend the
// claim. The key is still consumed and the row still revealed.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  focusTargetWithin,
  nearestMountedRowIndex,
  rowElementAt,
} from "@renderer/lib/windowed-row-markers.js";

/** Where one key press moves the active row. */
export type WindowedRowMove = "next" | "previous" | "first" | "last";

/**
 * The keys a windowed list consumes, and the move each means.
 *
 * A table rather than a `switch`, so a key not listed falls through to the page untouched.
 */
export const WINDOWED_ROW_MOVE_BY_KEY: Readonly<Record<string, WindowedRowMove>> = {
  ArrowDown: "next",
  ArrowUp: "previous",
  Home: "first",
  End: "last",
};

/** What `useWindowedRovingIndex` needs to know about a windowed list. */
export interface WindowedRovingIndexOptions {
  /** The whole enumeration, not the mounted window. */
  readonly rowCount: number;
  /**
   * Where the keyboard starts when nothing has moved: the selected row, or `0`.
   *
   * A move supersedes it, and a move outside a narrowed set falls back to it. An anchor the
   * mounted window does not hold is asked for through `revealIndex`, so a caller states which
   * row is selected and nothing about scrolling.
   */
  readonly anchorIndex: number;
  /** The element the moved-to row is looked up inside. */
  readonly containerRef: React.RefObject<HTMLElement | null>;
  /** Ask the window to mount a row. Called on every move, before focus is attempted. */
  readonly revealIndex: (rowIndex: number) => void;
  /**
   * The identity of the drawn sequence, so a move belongs to the set it was made in.
   *
   * Compared by identity, so a caller passes the array it drew or any value that is one
   * sequence. A move made under a different one is dropped and the keyboard falls back to
   * `anchorIndex`. Absent means the set never changes identity: no filtering, sorting or
   * re-fetching.
   */
  readonly rowSetIdentity?: unknown;
  /**
   * Any value that changes when the mounted window changes; a virtualizer's rendered row
   * array is the usual one.
   *
   * Typed `unknown` because shared hooks sit below the features that adopt a virtualizer. It
   * is only an effect dependency, so a fresh array every render costs extra effect runs and
   * is otherwise correct.
   */
  readonly windowRevision: unknown;
}

/** The active row and the key handler to attach to the list. */
export interface WindowedRovingIndex {
  /**
   * The one tabbable row, a position in both the current set and the mounted window.
   *
   * Where the roving row is not mounted this is the nearest row that is, and it becomes the
   * roving row again once the window produces it.
   */
  readonly activeIndex: number;
  readonly onKeyDown: (keyEvent: React.KeyboardEvent) => void;
}

/**
 * Where a move lands, clamped rather than wrapped.
 *
 * Wrapping would carry a reader across the whole enumeration for a press meant as one step.
 * Pure and exported so the rule is provable without a DOM.
 */
export function movedRowIndex(
  move: WindowedRowMove,
  activeIndex: number,
  rowCount: number,
): number {
  switch (move) {
    case "next":
      return Math.min(activeIndex + 1, rowCount - 1);
    case "previous":
      return Math.max(activeIndex - 1, 0);
    case "first":
      return 0;
    case "last":
      return rowCount - 1;
  }
}

/**
 * A position inside the set that exists now.
 *
 * Reconciles a remembered move or an anchor with the set's current bounds. An empty set has
 * no position and answers `0`.
 */
export function clampedRowIndex(candidateIndex: number, rowCount: number): number {
  if (rowCount <= 0 || !Number.isInteger(candidateIndex)) {
    return 0;
  }
  return Math.min(Math.max(candidateIndex, 0), rowCount - 1);
}

/**
 * How many effect runs a move's claim on focus may miss before it expires.
 *
 * Two: the run the move's own state write causes and the run that installs the mounted
 * fallback both precede an asynchronous `revealIndex`; a miss after those means the window
 * will not produce the row.
 */
const PENDING_FOCUS_RETRIES = 2;

/**
 * One tab stop, arrow keys inside it, and the moved-to row focused once it mounts.
 */
export function useWindowedRovingIndex(options: WindowedRovingIndexOptions): WindowedRovingIndex {
  const { rowCount, anchorIndex, containerRef, revealIndex, windowRevision, rowSetIdentity } =
    options;
  const [movedTo, setMovedTo] = useState<MovedRow | undefined>(undefined);
  const [mountedFallbackIndex, setMountedFallbackIndex] = useState<number | undefined>(undefined);
  const pendingFocus = useRef<PendingRowFocus | undefined>(undefined);
  const revealRequestedForIndex = useRef<number | undefined>(undefined);

  // A move stands only inside the sequence it was made in. Derived here rather than cleared
  // in state, so no render can read a stale move.
  const movedToIndex =
    movedTo !== undefined && movedTo.rowSetIdentity === rowSetIdentity ? movedTo.index : undefined;
  // `rovingIndex` is where the keyboard is; `activeIndex`, the tab stop, differs from it only
  // while the window does not hold that row.
  const rovingIndex = clampedRowIndex(movedToIndex ?? anchorIndex, rowCount);
  const activeIndex = clampedRowIndex(mountedFallbackIndex ?? rovingIndex, rowCount);

  useEffect(() => {
    if (rowCount === 0) {
      setMountedFallbackIndex(undefined);
      return;
    }
    if (rowElementAt(containerRef.current, rovingIndex) !== undefined) {
      // The window holds it, so the stop is the roving row and a later scroll away from it
      // may ask for it again.
      revealRequestedForIndex.current = undefined;
      setMountedFallbackIndex(undefined);
      return;
    }
    if (revealRequestedForIndex.current !== rovingIndex) {
      // Once per index, not per run: a virtualizer hands back a fresh window value every
      // render, so an unguarded call would re-ask on every render while waiting.
      revealRequestedForIndex.current = rovingIndex;
      revealIndex(rovingIndex);
    }
    setMountedFallbackIndex(nearestMountedRowIndex(containerRef.current, rovingIndex));
  }, [rovingIndex, containerRef, revealIndex, rowCount, windowRevision]);

  useEffect(() => {
    const pending = pendingFocus.current;
    if (pending === undefined) {
      return;
    }
    const { movedRow } = pending;
    if (movedRow.rowSetIdentity !== rowSetIdentity || movedRow.index !== rovingIndex) {
      // The claim's move is not the move on screen: the sequence was redrawn, or the set
      // narrowed and the index names a different row. Focusing there would answer a press
      // about the old list. Compared against the roving index, not the tab stop, which may
      // stand in for an unmounted row and would cancel every move out of the window.
      pendingFocus.current = undefined;
      return;
    }
    const row = rowElementAt(containerRef.current, rovingIndex);
    if (row === undefined) {
      // Not mounted on this run: an asynchronous `revealIndex` gets its budget of further
      // runs; past that the claim is dropped rather than left standing.
      pendingFocus.current =
        pending.retriesRemaining > 0
          ? { movedRow, retriesRemaining: pending.retriesRemaining - 1 }
          : undefined;
      return;
    }
    // Consumed before the focus call, so every path out of this effect spends it exactly once.
    pendingFocus.current = undefined;
    const target = focusTargetWithin(row);
    if (target === undefined) {
      // A row that declared no focus target is a row the keyboard cannot land on.
      return;
    }
    target.focus();
  }, [rovingIndex, containerRef, windowRevision, rowSetIdentity]);

  const onKeyDown = useCallback(
    (keyEvent: React.KeyboardEvent): void => {
      const move = WINDOWED_ROW_MOVE_BY_KEY[keyEvent.key];
      if (move === undefined || rowCount === 0) {
        return;
      }
      keyEvent.preventDefault();
      // Measured from the tab stop, where focus actually is: a move out of a stand-in row
      // starts from the row the reader can see.
      const moved = movedRowIndex(move, activeIndex, rowCount);
      // The sequence is captured with the move, and the claim is armed with that same value.
      const movedRow: MovedRow = { index: moved, rowSetIdentity };
      if (moved !== activeIndex) {
        // A boundary key at its boundary lands on the row already focused, so no claim is
        // armed: arming and consuming it would call focus() on the focused row, which still
        // moves scroll anchoring and :focus-visible. The key is still consumed and the row still
        // revealed.
        pendingFocus.current = { movedRow, retriesRemaining: PENDING_FOCUS_RETRIES };
      }
      setMovedTo(movedRow);
      // Retires the stand-in for the row this move supersedes; the effect above reinstates
      // one if the window has not produced the moved-to row.
      setMountedFallbackIndex(undefined);
      revealRequestedForIndex.current = moved;
      revealIndex(moved);
    },
    [activeIndex, revealIndex, rowCount, rowSetIdentity],
  );

  return { activeIndex, onKeyDown };
}

/**
 * Where the keyboard moved to, and the drawn sequence that index addresses.
 *
 * Row 499 of the list the reader saw and row 499 of the list drawn now are different rows.
 */
interface MovedRow {
  readonly index: number;
  readonly rowSetIdentity: unknown;
}

/**
 * A move waiting for its row to mount.
 *
 * `movedRow` is the very value the roving state holds, so a claim and its move cannot
 * disagree about the sequence; `retriesRemaining` is how many more runs may miss before the
 * claim is over.
 */
interface PendingRowFocus {
  readonly movedRow: MovedRow;
  readonly retriesRemaining: number;
}
