import { useCallback, useMemo } from "react";

import { usePlatformBridge } from "@renderer/services/platform/hooks/usePlatformBridge.js";
import { useSessionScopedState } from "@renderer/store/subject-scoped/useSessionScopedState.js";
import { RunGroupFoldState } from "../../run-groups/run-group-fold-state.js";
import { type RunGroup } from "../../run-groups/run-groups.js";
import { type RunGroupDisclosure } from "../run-group-fold.js";

/**
 * Hold one session's run group disclosure.
 *
 * `RunGroupFoldState` is the single owner of the rule — a live run group answers
 * open before any stored state is read — so this hook does not restate it; it
 * publishes the instance's opened set so a toggle repaints. The set is derived from
 * the instance and written nowhere else, which is what keeps it one source of truth
 * mirrored rather than two states kept in step.
 *
 * Scoped to the session, not the mount: session stores are opened and never closed, so
 * moving between two open sessions re-renders this pane at the same position rather
 * than unmounting it, and a per-mount holder would carry one session's opened run ids
 * into the other. Both halves are held per session, because the instance and its
 * published mirror are one fact.
 */
export function useRunGroupDisclosure(sessionId: string): RunGroupDisclosure {
  const bridge = usePlatformBridge();
  const collapse = useSessionScopedState(bridge, sessionId, () => new RunGroupFoldState());
  const opened = useSessionScopedState<ReadonlySet<string>>(
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
