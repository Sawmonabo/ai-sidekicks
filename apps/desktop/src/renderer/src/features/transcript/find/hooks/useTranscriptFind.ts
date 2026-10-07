// The find field's state and the walk over the rows the feed draws. It searches every row the
// store holds, whether or not the viewport's window holds it: a step to a row the window let go
// lands on it, as a link does. Matches inside folded run groups are counted apart, since opening
// the group is their exit.

import { useCallback, useMemo, useState } from "react";

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import {
  emptyFindResult,
  findInTranscript,
  stepFindMatch,
  type FindStepDirection,
  type FindResult,
} from "../matcher.js";

/** The find field's state, and the walk over one window's matches. */
export interface TranscriptFindState {
  readonly isOpen: boolean;
  readonly query: string;
  readonly result: FindResult;
  /** Matches inside folded terminal run groups; finished runs fold by default. */
  readonly foldedAwayMatchCount: number;
  /**
   * Where the walk is in the current result, or `-1` with nothing selected.
   *
   * Derived from the selected row, not held as an ordinal: the result recomputes as the log
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

/** The rows the walk searches, and what the run fold withheld from them. */
export interface TranscriptFindInputs {
  /** The rows the feed draws, in log order: every one a step can land on. */
  readonly rows: readonly TranscriptEventRow[];
  /**
   * The rows the run fold withheld, as that stage reported them. Re-deriving them would walk
   * the whole projection on every appended row while a query is set.
   */
  readonly foldedAwayRows: readonly TranscriptEventRow[];
  /**
   * Whether the feed draws a row. A folded row it draws nothing for stays hidden when its group
   * opens, so it is no match a person could reach.
   */
  readonly drawsRow: (row: TranscriptEventRow) => boolean;
}

/**
 * Searches the rows the feed draws and counts the matches the run fold withholds.
 *
 * The two sets are disjoint (a row the fold took is not drawn), so every match is in `result` or
 * in the count. The walk is held by row, not ordinal, because the result recomputes as the log
 * moves.
 */
export function useTranscriptFind(inputs: TranscriptFindInputs): TranscriptFindState {
  const { rows, foldedAwayRows, drawsRow } = inputs;
  const [isOpen, setIsOpen] = useState(false);
  const [openRequestCount, setOpenRequestCount] = useState(0);
  const [query, setQueryValue] = useState("");
  const [selectedMatchRowId, setSelectedMatchRowId] = useState<string | undefined>(undefined);

  const result = useMemo(
    () =>
      query.trim().length === 0 ? emptyFindResult(rows.length) : findInTranscript(rows, query),
    [rows, query],
  );

  const foldedAwayMatchCount = useMemo(
    () => matchesAmong(foldedAwayRows, query, drawsRow),
    [foldedAwayRows, query, drawsRow],
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
 * Matches among the folded rows the feed would draw once opened. A stage that removed nothing
 * hands back the shared empty set, which answers before any row is read.
 */
function matchesAmong(
  rows: readonly TranscriptEventRow[],
  query: string,
  drawsRow: (row: TranscriptEventRow) => boolean,
): number {
  if (rows.length === 0 || query.trim().length === 0) {
    return 0;
  }
  return findInTranscript(rows.filter(drawsRow), query).totalMatchCount;
}
