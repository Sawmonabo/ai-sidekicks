import { useCallback, useMemo } from "react";

import { usePlatformBridge } from "#renderer/services/platform/hooks/usePlatformBridge.js";
import { useSubjectScopedState } from "#renderer/hooks/subject-scoped/useSubjectScopedState.js";
import { TranscriptFoldState } from "../fold-state.js";

/** What one session's reader folded, and the acts that fold and open. */
export interface TranscriptFolds {
  /** The run groups folded, by run id; every other group is open. */
  readonly foldedRunIds: ReadonlySet<string>;
  /** The calls folded, by row id; every other call with a body is open. */
  readonly foldedCallRowIds: ReadonlySet<string>;
  /** Fold an open run group, or open a folded one. */
  readonly toggleRunGroup: (runId: string) => void;
  /** Open one run group, if it is folded. */
  readonly openRunGroup: (runId: string) => void;
  /** Fold every run group named. */
  readonly foldEveryRunGroup: (runIds: readonly string[]) => void;
  /** Open every run group named. */
  readonly unfoldEveryRunGroup: (runIds: readonly string[]) => void;
  /** Fold an open call, or open a folded one. */
  readonly toggleCall: (rowId: string) => void;
}

/**
 * Hold one session's folds. `TranscriptFoldState` owns them; this hook publishes copies of its
 * two sets so a press repaints. Both are held per session, because moving between open sessions
 * re-renders this pane instead of unmounting it, and a fold belongs to its own session's rows.
 */
export function useTranscriptFolds(sessionId: string): TranscriptFolds {
  const bridge = usePlatformBridge();
  const held = useSubjectScopedState(bridge, sessionId, () => new TranscriptFoldState());
  const foldedRunIdsState = useSubjectScopedState<ReadonlySet<string>>(
    bridge,
    sessionId,
    () => new Set<string>(),
  );
  const foldedCallRowIdsState = useSubjectScopedState<ReadonlySet<string>>(
    bridge,
    sessionId,
    () => new Set<string>(),
  );
  const foldState = held.value;
  const publishFoldedRunIds = foldedRunIdsState.publish;
  const publishFoldedCallRowIds = foldedCallRowIdsState.publish;
  const publishRunGroups = useCallback(() => {
    publishFoldedRunIds(new Set(foldState.foldedRunIds));
  }, [foldState, publishFoldedRunIds]);

  const toggleRunGroup = useCallback(
    (runId: string) => {
      foldState.toggleRunGroup(runId);
      publishRunGroups();
    },
    [foldState, publishRunGroups],
  );
  const openRunGroup = useCallback(
    (runId: string) => {
      if (foldState.openRunGroup(runId)) {
        publishRunGroups();
      }
    },
    [foldState, publishRunGroups],
  );
  const foldEveryRunGroup = useCallback(
    (runIds: readonly string[]) => {
      if (foldState.foldRunGroups(runIds)) {
        publishRunGroups();
      }
    },
    [foldState, publishRunGroups],
  );
  const unfoldEveryRunGroup = useCallback(
    (runIds: readonly string[]) => {
      if (foldState.unfoldRunGroups(runIds)) {
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

  const foldedRunIds = foldedRunIdsState.value;
  const foldedCallRowIds = foldedCallRowIdsState.value;
  return useMemo(
    () => ({
      foldedRunIds,
      foldedCallRowIds,
      toggleRunGroup,
      openRunGroup,
      foldEveryRunGroup,
      unfoldEveryRunGroup,
      toggleCall,
    }),
    [
      foldedRunIds,
      foldedCallRowIds,
      toggleRunGroup,
      openRunGroup,
      foldEveryRunGroup,
      unfoldEveryRunGroup,
      toggleCall,
    ],
  );
}
