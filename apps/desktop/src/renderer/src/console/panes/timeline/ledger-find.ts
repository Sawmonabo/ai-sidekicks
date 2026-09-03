// The find field's state, and the walk over the window the viewport is showing.
//
// It searches the VISIBLE window and not the log, because the walk offers to jump
// and a jump is performed by the viewport: a result counting rows the viewport does
// not hold would step to one and land nowhere, reporting success. What lies outside
// that window is counted beside the field instead — in two figures, because a match
// the cap took and a match the replay position has not reached are different states
// with different exits.

import { useCallback, useMemo, useState } from "react";

import {
  emptyFindResult,
  findInLedger,
  stepFindMatch,
  type LedgerFindResult,
} from "../../ledger/structure/index.js";
import { type VisibleLedgerWindow } from "./ledger-visible-window.js";

/** The find field's state, and the walk over one window's matches. */
export interface LedgerFindState {
  readonly isOpen: boolean;
  readonly query: string;
  readonly result: LedgerFindResult;
  /** Matches in rows the cap took out of this window. Named, never hidden. */
  readonly beyondWindowMatchCount: number;
  /**
   * Matches in rows the replay position has not reached.
   *
   * Its own figure rather than a share of the one above, because the sentence each
   * is rendered in offers a different move: nothing brings a pruned row back, and
   * scrubbing forward brings these back at once.
   */
  readonly notYetReplayedMatchCount: number;
  /**
   * Where the walk is in the CURRENT result, or `-1` with nothing selected.
   *
   * Derived from the selected ROW rather than held as an ordinal, because the
   * result recomputes whenever the visible window moves — every replay withhold,
   * every prune, every appended row — while the query stays the same. A held
   * ordinal survived into a shorter list, so the counter could read "10 of 2" and
   * the next step wrapped over the new count from a position that meant nothing.
   * A lookup answers `-1` exactly when the selected row has left the result, and
   * `-1` is already the sentinel the stepper enters the list from.
   */
  readonly currentMatchIndex: number;
  readonly setQuery: (query: string) => void;
  /**
   * Reveal the field without touching the query or the walk.
   *
   * Separate from `setQuery`, which also opens: the palette's "Find in ledger" row
   * and the chord behind it open a field somebody is about to type into, and
   * folding that into the query setter would have made the act pass an empty string
   * and reset a walk the reader was already in the middle of.
   */
  readonly open: () => void;
  /**
   * How many times `open` has been pressed, monotonic for the mount's life.
   *
   * The field is conditionally mounted, so a mount IS one open — but the chord
   * pressed while the field is already up has to put the caret back and select what
   * is there, and a mount-only effect cannot see that press. One counter covers both
   * entries and stays drivable by a unit test, which `autoFocus` is not.
   */
  readonly openRequestCount: number;
  readonly close: () => void;
  readonly step: (direction: "next" | "previous") => ReturnType<typeof stepFindMatch>;
}

/**
 * Search the window on screen, and count what lies outside it.
 *
 * Two passes over two DISJOINT sets rather than one pass over the log and a
 * partition afterwards, which costs the same and keeps the walkable result honest:
 * every match in `result` is a row `jumpToRow` can reach, and every match that is
 * not is in the count beside it.
 *
 * THE WALK IS HELD BY ROW, NOT BY ORDINAL. The result recomputes whenever the
 * window moves under a query somebody is still walking, and an ordinal into the
 * previous result is a position in a list that no longer exists.
 */
export function useLedgerFind(visible: VisibleLedgerWindow): LedgerFindState {
  const [isOpen, setIsOpen] = useState(false);
  const [openRequestCount, setOpenRequestCount] = useState(0);
  const [query, setQueryValue] = useState("");
  const [selectedMatchRowId, setSelectedMatchRowId] = useState<string | undefined>(undefined);

  const result = useMemo(
    () =>
      query.trim().length === 0
        ? emptyFindResult(visible.rows.length, visible.hasEarlierRows)
        : findInLedger(visible.rows, query, visible.hasEarlierRows),
    [visible, query],
  );

  const beyondWindowMatchCount = useMemo(
    () =>
      query.trim().length === 0
        ? 0
        : findInLedger(visible.prunedAwayRows, query, false).totalMatchCount,
    [visible, query],
  );

  const notYetReplayedMatchCount = useMemo(
    () =>
      query.trim().length === 0
        ? 0
        : findInLedger(visible.withheldByReplayRows, query, false).totalMatchCount,
    [visible, query],
  );

  // Looked up rather than remembered, so a result that recomputed under the walk
  // reports where the walk actually is — or that it is nowhere.
  const currentMatchIndex = useMemo(
    () =>
      selectedMatchRowId === undefined
        ? -1
        : result.matches.findIndex((match) => match.rowId === selectedMatchRowId),
    [result, selectedMatchRowId],
  );

  const setQuery = useCallback((next: string) => {
    setQueryValue(next);
    // A new query restarts the walk. Keeping the selection would resume inside a
    // match list built from a different question.
    setSelectedMatchRowId(undefined);
    setIsOpen(true);
  }, []);

  const step = useCallback(
    (direction: "next" | "previous") => {
      const outcome = stepFindMatch(result, currentMatchIndex, direction);
      if (outcome !== undefined) {
        setSelectedMatchRowId(outcome.match.rowId);
      }
      return outcome;
    },
    [result, currentMatchIndex],
  );

  const open = useCallback(() => {
    setIsOpen(true);
    // Bumped rather than set, so the field can tell a fresh press from a re-render
    // and take the caret on both the first open and every one after it.
    setOpenRequestCount((count) => count + 1);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setQueryValue("");
    setSelectedMatchRowId(undefined);
  }, []);

  return {
    isOpen,
    query,
    result,
    beyondWindowMatchCount,
    notYetReplayedMatchCount,
    currentMatchIndex,
    setQuery,
    open,
    openRequestCount,
    close,
    step,
  };
}
