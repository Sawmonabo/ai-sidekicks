import { useCallback, useMemo } from "react";

import { usePlatformBridge } from "#renderer/services/platform/hooks/usePlatformBridge.js";
import { useSubjectScopedState } from "#renderer/hooks/subject-scoped/useSubjectScopedState.js";
import { RunGroupFoldState } from "../../run-groups/run-group-fold-state.js";
import { type RunGroup } from "../../run-groups/run-groups.js";
import { type RunGroupDisclosure } from "../run-group-fold.js";

/**
 * Hold one session's run group disclosure. `RunGroupFoldState` owns the rule (a live run group
 * answers open before any stored state is read); this hook publishes its opened set so a toggle
 * repaints, deriving the set from the instance and writing it nowhere else. Both are held per
 * session, because moving between open sessions re-renders this pane instead of unmounting it.
 */
export function useRunGroupDisclosure(sessionId: string): RunGroupDisclosure {
  const bridge = usePlatformBridge();
  const collapse = useSubjectScopedState(bridge, sessionId, () => new RunGroupFoldState());
  const opened = useSubjectScopedState<ReadonlySet<string>>(
    bridge,
    sessionId,
    () => new Set<string>(),
  );
  const collapseState = collapse.value;
  const publishOpened = opened.publish;
  const publish = useCallback(() => {
    publishOpened(new Set(collapseState.openedTerminalRunIds));
  }, [collapseState, publishOpened]);
  const toggle = useCallback(
    (runGroup: RunGroup) => {
      if (collapseState.isOpen(runGroup)) {
        collapseState.close(runGroup);
      } else {
        collapseState.open(runGroup);
      }
      publish();
    },
    [collapseState, publish],
  );
  const collapseAllTerminal = useCallback(
    (runGroups: readonly RunGroup[]) => {
      collapseState.collapseAllTerminal(runGroups);
      publish();
    },
    [collapseState, publish],
  );
  const openedTerminalRunIds = opened.value;
  return useMemo(
    () => ({ openedTerminalRunIds, toggle, collapseAllTerminal }),
    [openedTerminalRunIds, toggle, collapseAllTerminal],
  );
}
