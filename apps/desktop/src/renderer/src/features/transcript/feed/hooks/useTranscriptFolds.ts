import { useCallback, useMemo } from "react";

import { usePlatformBridge } from "#renderer/services/platform/hooks/usePlatformBridge.js";
import { useSubjectScopedState } from "#renderer/hooks/subject-scoped/useSubjectScopedState.js";
import {
  RunCallWindows,
  type RunWindowEdge,
  type RunWindowMeasure,
} from "../../runs/call-window.js";
import { type RunGroup } from "../../runs/groups.js";
import { TranscriptFoldState } from "../fold-state.js";

/** What one session's reader folded and opened, and the acts that fold and open. */
export interface TranscriptFolds {
  /** The run groups folded, by key; every other group is open. */
  readonly foldedRunGroupKeys: ReadonlySet<string>;
  /** The calls folded, by row id; every other call with a body is open. */
  readonly foldedCallRowIds: ReadonlySet<string>;
  /** Fold an open run group, or open a folded one. */
  readonly toggleRunGroup: (runGroupKey: string) => void;
  /** Open one run group, if it is folded. */
  readonly openRunGroup: (runGroupKey: string) => void;
  /** Fold every run group named. */
  readonly foldEveryRunGroup: (runGroupKeys: readonly string[]) => void;
  /** Open every run group named. */
  readonly unfoldEveryRunGroup: (runGroupKeys: readonly string[]) => void;
  /** Fold an open call, or open a folded one. */
  readonly toggleCall: (rowId: string) => void;
  /** The calls whose output was opened whole, by row id; every other output is cut. */
  readonly openedOutputRowIds: ReadonlySet<string>;
  /** Draw one call's output whole. */
  readonly openOutput: (rowId: string) => void;
  /** The windows of the session's long runs. The same object for the session's lifetime. */
  readonly runCallWindows: RunCallWindows;
  /** How many times a reader moved a run's window: a new number repaints. */
  readonly runWindowMoveCount: number;
  /** Open the next stretch of a long run beyond `edge`, measured by `measure`. */
  readonly openRunStretch: (
    runGroup: RunGroup,
    edge: RunWindowEdge,
    measure: RunWindowMeasure,
  ) => void;
}

/**
 * Hold one session's folds and long-run windows. `TranscriptFoldState` owns the folds and
 * `RunCallWindows` the windows; this hook publishes copies of the three fold sets, and a count of
 * the window moves, so a press repaints. Both are held per session, because moving between open
 * sessions re-renders this pane instead of unmounting it, and a fold belongs to its own session's
 * rows.
 */
export function useTranscriptFolds(sessionId: string): TranscriptFolds {
  const bridge = usePlatformBridge();
  const held = useSubjectScopedState(bridge, sessionId, () => new TranscriptFoldState());
  const foldedRunGroupKeysState = useSubjectScopedState<ReadonlySet<string>>(
    bridge,
    sessionId,
    () => new Set<string>(),
  );
  const foldedCallRowIdsState = useSubjectScopedState<ReadonlySet<string>>(
    bridge,
    sessionId,
    () => new Set<string>(),
  );
  const openedOutputRowIdsState = useSubjectScopedState<ReadonlySet<string>>(
    bridge,
    sessionId,
    () => new Set<string>(),
  );
  const runCallWindows = useSubjectScopedState(bridge, sessionId, () => new RunCallWindows()).value;
  const runWindowMoveCountState = useSubjectScopedState(bridge, sessionId, () => 0);
  const foldState = held.value;
  const publishFoldedRunGroupKeys = foldedRunGroupKeysState.publish;
  const publishFoldedCallRowIds = foldedCallRowIdsState.publish;
  const publishRunGroups = useCallback(() => {
    publishFoldedRunGroupKeys(new Set(foldState.foldedRunGroupKeys));
  }, [foldState, publishFoldedRunGroupKeys]);

  const toggleRunGroup = useCallback(
    (runGroupKey: string) => {
      foldState.toggleRunGroup(runGroupKey);
      publishRunGroups();
    },
    [foldState, publishRunGroups],
  );
  const openRunGroup = useCallback(
    (runGroupKey: string) => {
      if (foldState.openRunGroup(runGroupKey)) {
        publishRunGroups();
      }
    },
    [foldState, publishRunGroups],
  );
  const foldEveryRunGroup = useCallback(
    (runGroupKeys: readonly string[]) => {
      if (foldState.foldRunGroups(runGroupKeys)) {
        publishRunGroups();
      }
    },
    [foldState, publishRunGroups],
  );
  const unfoldEveryRunGroup = useCallback(
    (runGroupKeys: readonly string[]) => {
      if (foldState.unfoldRunGroups(runGroupKeys)) {
        publishRunGroups();
      }
    },
    [foldState, publishRunGroups],
  );
  const toggleCall = useCallback(
    (rowId: string) => {
      foldState.toggleCall(rowId);
      publishFoldedCallRowIds(new Set(foldState.foldedCallRowIds));
    },
    [foldState, publishFoldedCallRowIds],
  );
  const publishOpenedOutputRowIds = openedOutputRowIdsState.publish;
  const openOutput = useCallback(
    (rowId: string) => {
      if (foldState.openOutput(rowId)) {
        publishOpenedOutputRowIds(new Set(foldState.openedOutputRowIds));
      }
    },
    [foldState, publishOpenedOutputRowIds],
  );

  const publishRunWindowMoveCount = runWindowMoveCountState.publish;
  const runWindowMoveCount = runWindowMoveCountState.value;
  const openRunStretch = useCallback(
    (runGroup: RunGroup, edge: RunWindowEdge, measure: RunWindowMeasure) => {
      runCallWindows.openStretch(runGroup, edge, measure);
      publishRunWindowMoveCount(runWindowMoveCount + 1);
    },
    [runCallWindows, publishRunWindowMoveCount, runWindowMoveCount],
  );

  const foldedRunGroupKeys = foldedRunGroupKeysState.value;
  const foldedCallRowIds = foldedCallRowIdsState.value;
  const openedOutputRowIds = openedOutputRowIdsState.value;
  return useMemo(
    () => ({
      foldedRunGroupKeys,
      foldedCallRowIds,
      toggleRunGroup,
      openRunGroup,
      foldEveryRunGroup,
      unfoldEveryRunGroup,
      toggleCall,
      openedOutputRowIds,
      openOutput,
      runCallWindows,
      runWindowMoveCount,
      openRunStretch,
    }),
    [
      foldedRunGroupKeys,
      foldedCallRowIds,
      toggleRunGroup,
      openRunGroup,
      foldEveryRunGroup,
      unfoldEveryRunGroup,
      toggleCall,
      openedOutputRowIds,
      openOutput,
      runCallWindows,
      runWindowMoveCount,
      openRunStretch,
    ],
  );
}
