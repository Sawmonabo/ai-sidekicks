// The find field's state and the walk over the window the viewport shows. It searches the
// visible window, not the log, because the viewport performs the jump and a match outside
// it would land nowhere. Matches outside are counted in two figures, one per stage that
// removed rows (the cap and the run fold), since each has a different exit.

import { useCallback, useMemo, useState } from "react";

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import {
  emptyFindResult,
  findInTranscript,
  stepFindMatch,
  type FindStepDirection,
  type FindResult,
} from "../find-model.js";
import { type VisibleTranscriptWindow } from "../../window/hooks/useVisibleTranscriptWindow.js";

/** The find field's state, and the walk over one window's matches. */
export interface TranscriptFindState {
  readonly isOpen: boolean;
  readonly query: string;
  readonly result: FindResult;
  /** Matches in rows the cap took out of this window. Named, never hidden. */
  readonly beyondWindowMatchCount: number;
  /** Matches inside folded terminal run groups; finished runs fold by default. */
  readonly foldedAwayMatchCount: number;
  /**
   * Where the walk is in the current result, or `-1` with nothing selected.
   *
   * Derived from the selected row, not held as an ordinal: the result recomputes as the window
   * moves, and a held ordinal could outlive a shorter list.
   */
  readonly currentMatchIndex: number;
  readonly setQuery: (query: string) => void;
  /**
   * Reveals the field without touching the query or the walk. Separate from `setQuery` so the
   * palette act cannot reset a walk in progress.
   */
  readonly open: () => void;
  /**
   * How many times `open` has been pressed. A counter rather than `autoFocus`, so a press while
   * the field is up re-takes the caret and a test can drive it.
   */
  readonly openRequestCount: number;
  readonly close: () => void;
  readonly step: (direction: FindStepDirection) => ReturnType<typeof stepFindMatch>;
}

/** Every stage between the loaded log and the rows on screen. */
export interface TranscriptFindInputs {
  /** The rows the walk searches — the only ones a step can land on. */
  readonly visible: VisibleTranscriptWindow;
  /**
   * The rows the run fold withheld, as that stage reported them. Re-deriving them would walk
   * the whole projection on every appended row while a query is set.
   */
  readonly foldedAwayRows: readonly TranscriptEventRow[];
}

/**
 * Searches the window on screen and counts what lies outside it.
 *
 * The three sets are disjoint (a row the fold took never reaches the viewport), so every match
 * is in `result` or in exactly one count. The walk is held by row, not ordinal, because the
 * result recomputes as the window moves.
 */
export function useTranscriptFind(inputs: TranscriptFindInputs): TranscriptFindState {
  const { visible, foldedAwayRows } = inputs;
  const [isOpen, setIsOpen] = useState(false);
  const [openRequestCount, setOpenRequestCount] = useState(0);
  const [query, setQueryValue] = useState("");
  const [selectedMatchRowId, setSelectedMatchRowId] = useState<string | undefined>(undefined);

  const result = useMemo(
    () =>
      query.trim().length === 0
        ? emptyFindResult(visible.rows.length)
        : findInTranscript(visible.rows, query),
    [visible, query],
  );

  const beyondWindowMatchCount = useMemo(
    () =>
      query.trim().length === 0
        ? 0
        : findInTranscript(visible.prunedAwayRows, query).totalMatchCount,
    [visible, query],
  );

  const foldedAwayMatchCount = useMemo(
    () => matchesAmong(foldedAwayRows, query),
    [foldedAwayRows, query],
  );

  // Looked up, not remembered, so a recomputed result reports where the walk actually is.
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
    foldedAwayMatchCount,
    currentMatchIndex,
    setQuery,
    open,
    openRequestCount,
    close,
    step,
  };
}

/**
 * Matches in one stage's removals. A stage that removed nothing hands back the shared empty
 * set the memo keys on, so an appended row never reaches this.
 */
function matchesAmong(rows: readonly TranscriptEventRow[], query: string): number {
  if (rows.length === 0 || query.trim().length === 0) {
    return 0;
  }
  return findInTranscript(rows, query).totalMatchCount;
}
