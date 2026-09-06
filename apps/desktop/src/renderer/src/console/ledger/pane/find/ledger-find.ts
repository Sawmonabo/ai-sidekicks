// The find field's state, and the walk over the window the viewport is showing.
//
// It searches the VISIBLE window and not the log, because the walk offers to jump
// and a jump is performed by the viewport: a result counting rows the viewport does
// not hold would step to one and land nowhere, reporting success. What lies outside
// that window is counted beside the field instead — in FOUR figures, one per
// narrowing, because each names a different state with a different exit.
//
// FOUR AND NOT TWO, AND THE TWO THAT WERE MISSING ARE THE COMMON ONES. The cap and
// the replay position were counted from the start; the filter and the terminal-run
// fold were not, and rule 7 folds every finished run by default — so on a completed
// session most of the log sits behind a chapter header, and a term in one of those
// rows was reported as no match at all rather than as a match the reader could reach
// by opening the chapter. A row either narrowing removed is still a LOADED row, and
// a field that says it searched the loaded rows has to account for it.

import { useCallback, useMemo, useState } from "react";

import { type TimelineRow } from "@ai-sidekicks/contracts";

import {
  emptyFindResult,
  findInLedger,
  stepFindMatch,
  type FindStepDirection,
  type LedgerFindResult,
} from "../../structure/index.js";
import { type VisibleLedgerWindow } from "../window/index.js";

/** The find field's state, and the walk over one window's matches. */
export interface LedgerFindState {
  readonly isOpen: boolean;
  readonly query: string;
  readonly result: LedgerFindResult;
  /** Matches in rows the cap took out of this window. Named, never hidden. */
  readonly beyondWindowMatchCount: number;
  /**
   * Matches in rows the facet bar is narrowing away.
   *
   * Its own figure for the reason the replay count is: clearing the narrowing brings
   * every one of them back at once, which is a different move from scrubbing a
   * replay and a different one again from a row the cap dropped for good.
   */
  readonly filteredAwayMatchCount: number;
  /**
   * Matches inside terminal run chapters this ledger has folded.
   *
   * Rule 7 folds finished runs by default, so this is the largest of the four on any
   * session that has finished a run — and it was the one nothing counted.
   */
  readonly foldedAwayMatchCount: number;
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
  readonly step: (direction: FindStepDirection) => ReturnType<typeof stepFindMatch>;
}

/** Every stage between the loaded log and the rows on screen. */
export interface LedgerFindInputs {
  /** The rows the walk searches — the only ones a step can land on. */
  readonly visible: VisibleLedgerWindow;
  /**
   * The rows the facet bar took out, as the narrowing stage reported them.
   *
   * TAKEN FROM THE STAGE RATHER THAN DERIVED HERE, because the stage is the pass that
   * already separated them. Re-deriving it meant a `Set` over the narrowed rows and a
   * filter over the whole unfurled projection, on every appended row, for as long as a
   * query sat in the field — and the empty answer, which is the one nearly every
   * ledger gives, cost exactly as much as a real one.
   */
  readonly filteredAwayRows: readonly TimelineRow[];
  /** The rows the terminal-run fold withheld, as the fold reported them. */
  readonly foldedAwayRows: readonly TimelineRow[];
}

/**
 * Search the window on screen, and count what lies outside it.
 *
 * Five passes over five DISJOINT sets rather than one pass over the log and a
 * partition afterwards, which costs the same and keeps the walkable result honest:
 * every match in `result` is a row `jumpToRow` can reach, and every match that is
 * not is in one of the four counts beside it, under the name of the narrowing
 * holding it.
 *
 * THE STAGES ARE READ AS SETS, one difference per narrowing, so a row is counted
 * once and against the FIRST thing that removed it. A row the filter took never
 * reaches the fold, so it cannot be reported as folded away, and the four counts
 * plus the walk partition the loaded log exactly.
 *
 * THE WALK IS HELD BY ROW, NOT BY ORDINAL. The result recomputes whenever the
 * window moves under a query somebody is still walking, and an ordinal into the
 * previous result is a position in a list that no longer exists.
 */
export function useLedgerFind(inputs: LedgerFindInputs): LedgerFindState {
  const { visible, filteredAwayRows, foldedAwayRows } = inputs;
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

  const filteredAwayMatchCount = useMemo(
    () => matchesAmong(filteredAwayRows, query),
    [filteredAwayRows, query],
  );

  const foldedAwayMatchCount = useMemo(
    () => matchesAmong(foldedAwayRows, query),
    [foldedAwayRows, query],
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
    (direction: FindStepDirection) => {
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
    filteredAwayMatchCount,
    foldedAwayMatchCount,
    notYetReplayedMatchCount,
    currentMatchIndex,
    setQuery,
    open,
    openRequestCount,
    close,
    step,
  };
}

/**
 * Matches in one stage's removals.
 *
 * The set arrives already separated, so this walks it and nothing else — and a stage
 * that removed nothing hands back the one shared empty set, which the memo above keys
 * on, so an appended row does not even reach this function.
 *
 * The four counts stay a partition because the stages report DISJOINT removals: a row
 * the filter took never reaches the fold, so it cannot be reported as folded away.
 */
function matchesAmong(rows: readonly TimelineRow[], query: string): number {
  if (rows.length === 0 || query.trim().length === 0) {
    return 0;
  }
  return findInLedger(rows, query, false).totalMatchCount;
}
