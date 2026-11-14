// The find field's state and the walk over every row the window holds, whether a run group's fold
// or a long run's window hides it and whether or not the viewport's window holds it: the caller's
// step opens what hides a row before it lands on it, as a link does. The search is held across
// the log's updates, which arrive per event, so the count follows a row that goes, and a step
// from a hit that left moves on to the next live one.

import { useCallback, useMemo, useState } from "react";

import { type SystemMessageReading } from "../../system-messages/classifier.js";
import {
  FindMatchList,
  stepFindMatch,
  type FindMatch,
  type FindStepDirection,
  type FindResult,
} from "../matcher.js";
import type { ProjectedTranscriptRow } from "#renderer/store/session/entities/vocabulary.js";

/** The find field's state, and the walk over one window's matches. */
export interface TranscriptFindState {
  readonly isOpen: boolean;
  readonly query: string;
  readonly result: FindResult;
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

/** The rows the walk searches. */
export interface TranscriptFindInputs {
  /** Every row the window holds, in log order, folded away or not. */
  readonly rows: readonly ProjectedTranscriptRow[];
  /** The system message behind each row of the unfurled window, whose line a match reads. */
  readonly systemMessageByRowId: ReadonlyMap<string, SystemMessageReading>;
}

/**
 * Searches every row the window holds. The walk is held by row, not ordinal, because the result
 * recomputes as the log moves.
 */
export function useTranscriptFind(inputs: TranscriptFindInputs): TranscriptFindState {
  const { rows, systemMessageByRowId } = inputs;
  const [findMatchList] = useState(() => new FindMatchList());
  const [isOpen, setIsOpen] = useState(false);
  const [openRequestCount, setOpenRequestCount] = useState(0);
  const [query, setQueryValue] = useState("");
  // The selected hit, kept with its place in the log so a step from a hit whose row left moves
  // on to the next live one.
  const [selectedMatch, setSelectedMatch] = useState<FindMatch | undefined>(undefined);

  const result = useMemo(
    () => findMatchList.resultOf(rows, query, systemMessageByRowId),
    [findMatchList, rows, query, systemMessageByRowId],
  );

  // Looked up, not remembered, so a recomputed result reports where the walk actually is.
  const currentMatchIndex = useMemo(
    () =>
      selectedMatch === undefined
        ? -1
        : result.matches.findIndex((match) => match.rowId === selectedMatch.rowId),
    [result, selectedMatch],
  );

  const setQuery = useCallback((next: string) => {
    setQueryValue(next);
    // A new query restarts the walk. Keeping the selection would resume inside a
    // match list built from a different question.
    setSelectedMatch(undefined);
    setIsOpen(true);
  }, []);

  const step = useCallback(
    (direction: FindStepDirection) => {
      const outcome = stepFindMatch(result, selectedMatch, direction);
      if (outcome !== undefined) {
        setSelectedMatch(outcome.match);
      }
      return outcome;
    },
    [result, selectedMatch],
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
    setSelectedMatch(undefined);
  }, []);

  return {
    isOpen,
    query,
    result,
    currentMatchIndex,
    setQuery,
    open,
    openRequestCount,
    close,
    step,
  };
}
