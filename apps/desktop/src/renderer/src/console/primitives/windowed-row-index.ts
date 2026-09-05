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
// THE ROW HAS ONE TAB STOP AND THE ROVING INDEX CONTROLS IT. This is the composite
// widget rule as the WAI-ARIA Authoring Practices Guide states it, in "Developing a
// Keyboard Interface / Managing Focus Within Components Using a Roving tabindex": the
// element that is in the tab sequence carries `tabindex="0"` and EVERY other focusable
// element contained in the composite carries `tabindex="-1"`. A row that put the
// roving index on its wrapper while a button inside it kept its native stop obeyed
// neither half — every mounted descendant stayed reachable by Tab, so the window's
// moving row count was back in the page's tab order; the active row had two stops; and
// this effect resolved its focus target with a `button, a[href], …, [tabindex]`
// selector that the WRAPPER matched first, so focus landed on the wrapper by accident
// rather than on anything declared.
//
// So the target is DECLARED and never discovered. `WindowedListRow` marks exactly one
// element per row with the target attribute `windowed-row-markers.ts` owns — the
// wrapper where the row
// holds its own stop, the one control the row delegates to where its content IS a
// control — and writes the roving `tabIndex` on that same element and on no other.
// One element per row carries the marker and the stop together, which is what makes
// "exactly one tab stop per row" a property of the component rather than of a caller's
// discipline. This effect focuses the marked element, and a row that marked none is a
// row the keyboard cannot land on.
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
// the row it was armed for and carries a budget of the effect runs it may wait
// through, and it is consumed exactly once: it focuses that row, or it is dropped. It
// is dropped when the set narrowed under it and the index now points at a DIFFERENT
// row (focusing there would answer a key press about row 39 by moving to row 4), and
// it is dropped once the budget is spent — one retry, which is what an asynchronous
// `revealIndex` needs, and not a standing claim on the page's focus.
//
// AND THE ANCHOR IS ASKED FOR RATHER THAN ASSUMED MOUNTED. A list reopened on a
// selection starts its keyboard on that row, and a window mounts the rows a SCROLL
// POSITION needs — two facts that only agree when the caller has already scrolled the
// selection into view. Where they disagreed, this hook made an unmounted row active
// and every mounted row was rendered `isTabbable={false}`, so the list held no
// sequential tab stop at all: the reachability defect the clamp exists for, arriving
// through the anchor instead of through a narrowed set. Requiring the caller to align
// the two would be a rule no caller can check and no gate can state.
//
// So the anchor is REVEALED, once per index, through the same `revealIndex` a move
// uses — and because a reveal is asynchronous, the list needs a tab stop for the
// renders in between. That is the mounted fallback: while the roving row is not in
// the window, the NEAREST mounted row holds the stop, so Tab always reaches the list
// and the arrows always move from the row the reader can see. The fallback shadows
// the roving index for the tab stop only; the pending focus claim still names the row
// the key asked for, which is why the two are separate numbers below. A window that
// has mounted no rows at all gets no stop, because there is none to give.
//
// AND A MOVE THAT GOES NOWHERE ARMS NOTHING. `End` on the last row, `Home` on the
// first, `ArrowDown` at the bottom: each is a key this list consumes whose landing
// place is the row the keyboard is already on. Arming a claim there is the delayed
// focus steal in its purest form — `setMovedToIndex` stores the value it already
// holds, so React schedules no render, so no effect run exists to spend the claim,
// and it sits in the ref until some unrelated store update runs the effect with the
// row mounted and pulls focus back out of whatever the reader had tabbed to. The
// claim is therefore MINTED ONLY WHERE FOCUS HAS SOMEWHERE TO GO, rather than minted
// and consumed in the same tick: consuming it would mean calling `focus()` on the
// element that already has it, which is a real DOM event (`focus` does not fire
// again, but scroll anchoring and `:focus-visible` do move) for a key press that
// asked for nothing. The list still consumes the key and still asks the window for
// the row, because a reader pressing `End` at the end is asking to SEE the end.
//
// AND THE BUDGET COUNTS RUNS RATHER THAN COMPARING THE WINDOW. The claim used to hold
// the `windowRevision` it was armed against and expire when that value changed, which
// reads as the more precise rule and is defeated by the value a virtualizer actually
// hands back: a fresh array every render. The first run after the arm then already
// compares unequal, so the one retry is spent before the reveal it exists for can
// answer and the move focuses nothing at all. The caller cannot be asked to stabilise
// that value either — this family may not name the virtualizer's types, so the option
// cannot say which of them to memoize on — which leaves a count of this hook's own
// effect runs as the one bound it can hold without trusting its caller's identities.

import { useCallback, useEffect, useRef, useState } from "react";

import { focusTargetWithin, nearestMountedRowIndex, rowElementAt } from "./windowed-row-markers.js";

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
   *
   * It carries no alignment obligation: an anchor the mounted window does not hold is
   * asked for through `revealIndex`, and the nearest mounted row holds the stop until
   * it arrives. A caller states which row is selected and nothing about scrolling.
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
   *
   * It is read as an effect DEPENDENCY and compared against nothing, so a caller
   * whose value is a fresh array every render costs extra effect runs and is
   * otherwise correct. That is deliberate — see the budget above.
   */
  readonly windowRevision: unknown;
}

export interface WindowedRovingIndex {
  /**
   * The one row that is tabbable, as a position in the current set AND in the mounted
   * window.
   *
   * Two claims rather than one: a row a caller renders `isTabbable` for has to be a
   * row the caller is rendering, or the list has no stop. Where the roving row is not
   * mounted this is the nearest row that is, and it becomes the roving row again the
   * moment the window produces it.
   */
  readonly activeIndex: number;
  readonly onKeyDown: (keyEvent: React.KeyboardEvent) => void;
}

/**
 * How many effect runs a move may wait through before its claim on focus expires.
 *
 * Two, and both are this hook's own. The arm is followed immediately by the run the
 * move's own `setMovedToIndex` causes, on which an asynchronous `revealIndex` has not
 * answered yet; that run also installs the mounted fallback for a row the window has
 * not produced, which is a second state write and so a second run, still before the
 * reveal can have landed. The run after those two is the reveal's, and a move still
 * unmounted there is a move whose row the window is not going to produce.
 *
 * It is a count of runs rather than of renders because that is what this hook can
 * observe — see the header on why the window's own identity cannot be compared.
 */
const PENDING_FOCUS_RETRIES = 2;

/**
 * A move waiting for its row to mount, and the two facts that bound it.
 *
 * `rowIndex` is the row the key press asked for, so a set that narrows underneath
 * is answered by dropping the move rather than by focusing whichever row the clamp
 * now points at. `retriesRemaining` is how many more runs may miss before the claim
 * is over, which is what separates "the window has not answered yet" from "the
 * window answered and this row was not in it".
 */
interface PendingRowFocus {
  readonly rowIndex: number;
  readonly retriesRemaining: number;
}

/**
 * One tab stop, arrow keys inside it, and the moved-to row focused once it mounts.
 */
export function useWindowedRovingIndex(options: WindowedRovingIndexOptions): WindowedRovingIndex {
  const { rowCount, anchorIndex, containerRef, revealIndex, windowRevision } = options;
  const [movedToIndex, setMovedToIndex] = useState<number | undefined>(undefined);
  const [mountedFallbackIndex, setMountedFallbackIndex] = useState<number | undefined>(undefined);
  const pendingFocus = useRef<PendingRowFocus | undefined>(undefined);
  const revealRequestedForIndex = useRef<number | undefined>(undefined);

  // Where the keyboard IS, and where the one tab stop can be put — the same number
  // whenever the window holds the roving row, and different exactly while it does not.
  const rovingIndex = clampedRowIndex(movedToIndex ?? anchorIndex, rowCount);
  const activeIndex = clampedRowIndex(mountedFallbackIndex ?? rovingIndex, rowCount);

  useEffect(() => {
    if (rowCount === 0) {
      setMountedFallbackIndex(undefined);
      return;
    }
    if (rowElementAt(containerRef.current, rovingIndex) !== undefined) {
      // The window holds it, so the stop is the roving row itself and a later scroll
      // away from it is free to ask for it again.
      revealRequestedForIndex.current = undefined;
      setMountedFallbackIndex(undefined);
      return;
    }
    if (revealRequestedForIndex.current !== rovingIndex) {
      // Once per index, never once per run: a virtualizer hands back a fresh window
      // value every render, so an unguarded call here would ask for the same row on
      // every render the list makes while it waits.
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
    if (pending.rowIndex !== rovingIndex) {
      // The set narrowed under the move, so the index now names a row nobody asked
      // for. Dropped rather than followed: answering a key press about row 39 by
      // focusing row 4 is a different act, not a smaller one. Compared against the
      // ROVING index and never the tab stop: the tab stop may be standing in for an
      // unmounted row, and a claim dropped against a stand-in would cancel every move
      // out of the window.
      pendingFocus.current = undefined;
      return;
    }
    const row = rowElementAt(containerRef.current, rovingIndex);
    if (row === undefined) {
      // The row is not mounted on this run. A `revealIndex` that scrolls
      // asynchronously gets its budget of further runs to answer; past that the
      // claim on the page's focus is dropped rather than left standing for whatever
      // renders next.
      pendingFocus.current =
        pending.retriesRemaining > 0
          ? { rowIndex: pending.rowIndex, retriesRemaining: pending.retriesRemaining - 1 }
          : undefined;
      return;
    }
    // Consumed here, before the focus call, so every path out of this effect has
    // spent the claim exactly once.
    pendingFocus.current = undefined;
    const target = focusTargetWithin(row);
    if (target === undefined) {
      // A row that declared no focus target is a row the keyboard cannot land on.
      return;
    }
    target.focus();
  }, [rovingIndex, containerRef, windowRevision]);

  const onKeyDown = useCallback(
    (keyEvent: React.KeyboardEvent): void => {
      const move = WINDOWED_ROW_MOVE_BY_KEY[keyEvent.key];
      if (move === undefined || rowCount === 0) {
        return;
      }
      keyEvent.preventDefault();
      // Measured from the tab stop, which is where focus actually is: a move out of a
      // stand-in row starts from the row the reader can see, not from the one the
      // window has yet to produce.
      const moved = movedRowIndex(move, activeIndex, rowCount);
      if (moved !== activeIndex) {
        // See the header: a boundary key pressed at that boundary lands on the row
        // the keyboard is already on, and a claim armed for it has no render to
        // spend it on. The reveal and the state write below still run — the key was
        // consumed, and the reader asked to see that end of the list.
        pendingFocus.current = { rowIndex: moved, retriesRemaining: PENDING_FOCUS_RETRIES };
      }
      setMovedToIndex(moved);
      // The stand-in is retired by the same act that supersedes the row it stood in
      // for; the effect above reinstates one if the window still has not produced the
      // moved-to row.
      setMountedFallbackIndex(undefined);
      revealRequestedForIndex.current = moved;
      revealIndex(moved);
    },
    [activeIndex, revealIndex, rowCount],
  );

  return { activeIndex, onKeyDown };
}
