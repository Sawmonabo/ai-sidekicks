// Where a windowed list's keyboard is, and how the moved-to row is found once it
// mounts.
//
// A WINDOW MOUNTS THE ROWS A SCROLL POSITION NEEDS, which makes the keyboard the
// hard half of every windowed list: tabbing can only reach what is mounted, so a
// list whose rows are each a tab stop puts a MOVING number of stops in the page's
// tab order, and a list with none is a list a keyboard cannot enter. The answer is
// the composite-widget pattern — one entry is tabbable, the arrows move which — and
// it is written here once rather than per list, because the two halves that are easy
// to get wrong are the same in every list that has one.
//
// THE TWO HALVES ARE SEPARATE BECAUSE THE ROW MAY NOT EXIST YET. Moving asks the
// window for a row the viewport has very likely not mounted, so the key handler
// records where focus is GOING and the effect takes it there on whichever render the
// row arrives on — which is why the mounted window is one of that effect's
// dependencies rather than only the index.
//
// AND THE ACTIVE INDEX IS CLAMPED TO THE SET THAT EXISTS NOW. This is the defect the
// clamp is here for: a person arrows to row 39, a filter narrows the list to five,
// and a remembered index of 39 matches no mounted row — so `isTabbable` is false on
// every row and the whole list silently leaves the page's tab order. The index a
// caller renders against is therefore always a position in the CURRENT set, and the
// remembered move is what is discarded, never the list's reachability.
//
// FOCUS IS ONLY EVER TAKEN, NEVER GIVEN BACK, AND THE CLAIM EXPIRES. The effect
// moves focus for a key this handler itself consumed, so nothing sets the pending
// claim but the handler and the handler runs only on a key delivered to the list.
// That says who arms it and not how long it lives, and a claim that never expires is
// the second half of the defect: a move whose row the window never mounted left a
// standing flag, so an unrelated store update thirty seconds later — a render this
// list did not cause and the reader had long since tabbed away from — found the row
// mounted and pulled focus out of whatever they were typing in. So the claim names
// the row it was armed for and the mounted window it was armed against, and it is
// consumed exactly once: it focuses that row, or it is dropped. It is dropped when
// the set narrowed under it and the index now points at a DIFFERENT row (focusing
// there would answer a key press about row 39 by moving to row 4), and it is dropped
// after one window change that did not bring the row in — one retry, which is what
// an asynchronous `revealIndex` needs, and not a standing claim on the page's focus.

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The attribute a windowed row carries its absolute index on.
 *
 * Declared here rather than in the component because this module is the READER and
 * `WindowedListRow` is the writer: two sides of one seam share a module, so a rename
 * cannot leave the lookup querying an attribute nothing writes.
 */
export const WINDOWED_ROW_INDEX_ATTRIBUTE = "data-index";

/**
 * What can be focused inside a row when the row element itself is not the tab stop.
 *
 * A list whose rows are controls (a file list of buttons) keeps activation on the
 * control, so the tab stop is inside the row rather than on it. The selector is the
 * ordinary interactive set; `[tabindex]` is last because a row that names its own
 * stop has said which element it wants.
 */
const FOCUSABLE_WITHIN_ROW = "button, a[href], input, select, textarea, [tabindex]";

/** Where one key press moves the active row. */
export type WindowedRowMove = "next" | "previous" | "first" | "last";

/**
 * The keys a windowed list consumes, and what each one means.
 *
 * A table rather than a `switch` so the set is one value a test can walk, and so a
 * key this list does NOT handle falls through to the page untouched.
 */
export const WINDOWED_ROW_MOVE_BY_KEY: Readonly<Record<string, WindowedRowMove>> = {
  ArrowDown: "next",
  ArrowUp: "previous",
  Home: "first",
  End: "last",
};

/**
 * Where a move lands, clamped rather than wrapped.
 *
 * A list has two ends, and an arrow key that wrapped from the last row to the first
 * would move a reader across the whole enumeration for a press they meant as one
 * step. Pure and exported so the rule is provable without a DOM.
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
 * Exported because it is the whole of the shrinking-set claim: a remembered move and
 * an anchor are both candidate positions in a set that may since have narrowed, and
 * this is the one place either is reconciled with the set's real bounds. An empty set
 * has no position and answers `0`, which is where the keyboard starts when rows
 * arrive.
 */
export function clampedRowIndex(candidateIndex: number, rowCount: number): number {
  if (rowCount <= 0 || !Number.isInteger(candidateIndex)) {
    return 0;
  }
  return Math.min(Math.max(candidateIndex, 0), rowCount - 1);
}

export interface WindowedRovingIndexOptions {
  /** The whole enumeration, not the mounted window. */
  readonly rowCount: number;
  /**
   * Where the keyboard starts when nothing has moved — the selected row, or `0`.
   *
   * A move supersedes it, and a move that falls outside a narrowed set falls back to
   * it, so a list reopened on a selection puts its one tab stop on that selection.
   */
  readonly anchorIndex: number;
  /** The element the moved-to row is looked up inside. */
  readonly containerRef: React.RefObject<HTMLElement | null>;
  /** Ask the window to mount a row. Called on every move, before focus is attempted. */
  readonly revealIndex: (rowIndex: number) => void;
  /**
   * Any value that changes when the mounted window changes.
   *
   * The rendered row array a virtualizer hands back is the usual one. It is typed
   * `unknown` on purpose: this family sits below the one that adopts a virtualizer,
   * and a primitive that named that library's row type would be an upward edge.
   */
  readonly windowRevision: unknown;
}

export interface WindowedRovingIndex {
  /** The one row that is tabbable, as a position in the current set. */
  readonly activeIndex: number;
  readonly onKeyDown: (keyEvent: React.KeyboardEvent) => void;
}

/**
 * A move waiting for its row to mount, and the two facts that bound it.
 *
 * `rowIndex` is the row the key press asked for, so a set that narrows underneath
 * is answered by dropping the move rather than by focusing whichever row the clamp
 * now points at. `armedAtWindowRevision` is the mounted window the move was armed
 * against, so "the window has not answered yet" and "the window answered and this
 * row was not in it" are distinguishable — the first is worth one more render, the
 * second is over.
 */
interface PendingRowFocus {
  readonly rowIndex: number;
  readonly armedAtWindowRevision: unknown;
}

/**
 * One tab stop, arrow keys inside it, and the moved-to row focused once it mounts.
 */
export function useWindowedRovingIndex(options: WindowedRovingIndexOptions): WindowedRovingIndex {
  const { rowCount, anchorIndex, containerRef, revealIndex, windowRevision } = options;
  const [movedToIndex, setMovedToIndex] = useState<number | undefined>(undefined);
  const pendingFocus = useRef<PendingRowFocus | undefined>(undefined);

  const activeIndex = clampedRowIndex(movedToIndex ?? anchorIndex, rowCount);

  useEffect(() => {
    const pending = pendingFocus.current;
    if (pending === undefined) {
      return;
    }
    if (pending.rowIndex !== activeIndex) {
      // The set narrowed under the move, so the index now names a row nobody asked
      // for. Dropped rather than followed: answering a key press about row 39 by
      // focusing row 4 is a different act, not a smaller one.
      pendingFocus.current = undefined;
      return;
    }
    const row = containerRef.current?.querySelector<HTMLElement>(
      `[${WINDOWED_ROW_INDEX_ATTRIBUTE}="${String(activeIndex)}"]`,
    );
    if (row === null || row === undefined) {
      if (!Object.is(pending.armedAtWindowRevision, windowRevision)) {
        // The window changed and this row was not in it. A `revealIndex` that
        // scrolls asynchronously gets exactly that one change to answer; past it
        // the claim on the page's focus is dropped rather than left standing for
        // whatever renders next.
        pendingFocus.current = undefined;
      }
      return;
    }
    // Consumed here, before the focus call, so every path out of this effect has
    // spent the claim exactly once.
    pendingFocus.current = undefined;
    const target = row.matches(FOCUSABLE_WITHIN_ROW)
      ? row
      : row.querySelector<HTMLElement>(FOCUSABLE_WITHIN_ROW);
    if (target === null) {
      // A row with nothing focusable in it is a row the keyboard cannot land on.
      return;
    }
    target.focus();
  }, [activeIndex, containerRef, windowRevision]);

  const onKeyDown = useCallback(
    (keyEvent: React.KeyboardEvent): void => {
      const move = WINDOWED_ROW_MOVE_BY_KEY[keyEvent.key];
      if (move === undefined || rowCount === 0) {
        return;
      }
      keyEvent.preventDefault();
      const moved = movedRowIndex(move, activeIndex, rowCount);
      pendingFocus.current = { rowIndex: moved, armedAtWindowRevision: windowRevision };
      setMovedToIndex(moved);
      revealIndex(moved);
    },
    [activeIndex, revealIndex, rowCount, windowRevision],
  );

  return { activeIndex, onKeyDown };
}
