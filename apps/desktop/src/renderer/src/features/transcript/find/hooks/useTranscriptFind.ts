// The find field's state and the walk over the rows the feed draws. It searches every row the
// store holds, whether or not the viewport's window holds it: a step to a row the window let go
// lands on it, as a link does. Matches inside folded run groups are counted apart, since opening
// the group is their exit. Both are held across the log's updates, which arrive per event.

import { useCallback, useMemo, useState } from "react";

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { type TranscriptRowRenderer } from "../../rows/renderer.js";
import { type SystemMessageReading } from "../../system-messages/classifier.js";
import {
  FindMatchList,
  FoldedMatchCount,
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
   * The system message behind each row of the unfurled window, folded rows included. With
   * `drawsBody` it says whether the feed draws a row: a folded row it draws nothing for stays
   * hidden when its group opens, so it is no match a person could reach.
   */
  readonly systemMessageByRowId: ReadonlyMap<string, SystemMessageReading>;
  /** The registered renderer's answer to whether it draws a body for a row. */
  readonly drawsBody: TranscriptRowRenderer["drawsBody"];
}

/**
 * Searches the rows the feed draws and counts the matches the run fold withholds.
 *
 * The two sets are disjoint (a row the fold took is not drawn), so every match is in `result` or
 * in the count. The walk is held by row, not ordinal, because the result recomputes as the log
 * moves.
 */
export function useTranscriptFind(inputs: TranscriptFindInputs): TranscriptFindState {
  const { rows, foldedAwayRows, systemMessageByRowId, drawsBody } = inputs;
  const [findMatchList] = useState(() => new FindMatchList());
  const [foldedMatchCount] = useState(() => new FoldedMatchCount());
  const [isOpen, setIsOpen] = useState(false);
  const [openRequestCount, setOpenRequestCount] = useState(0);
  const [query, setQueryValue] = useState("");
  const [selectedMatchRowId, setSelectedMatchRowId] = useState<string | undefined>(undefined);

  const result = useMemo(
    () => findMatchList.resultOf(rows, query, systemMessageByRowId),
    [findMatchList, rows, query, systemMessageByRowId],
  );

  const foldedAwayMatchCount = useMemo(
    () => foldedMatchCount.countOf(foldedAwayRows, query, systemMessageByRowId, drawsBody),
    [foldedMatchCount, foldedAwayRows, query, systemMessageByRowId, drawsBody],
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
