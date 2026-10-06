import { useCallback, useMemo } from "react";

import type { RunId } from "@ai-sidekicks/contracts/run/id";

import { usePlatformBridge } from "#renderer/services/platform/hooks/usePlatformBridge.js";
import { useSubjectScopedState } from "#renderer/hooks/subject-scoped/useSubjectScopedState.js";
import { useSubjectScopedResource } from "#renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import { type SubjectScopedDisposal } from "#renderer/lib/subject-scoped/disposal.js";
import {
  CHILD_RUN_SUMMARIZED,
  ChildRunExpansionState,
  type ChildRunDisclosure,
  type ChildRunExpansion,
} from "../child-run-expansion.js";

/**
 * How a session's expansions end, so the render hands over a stable pair. Terminal, not
 * releasing: a let-go read line is not one the next render may open a round on, and `isAbandoned`
 * lets React's double-mount recognize the disposed object and mint a fresh one.
 */
const CHILD_RUN_EXPANSION_DISPOSAL: SubjectScopedDisposal<ChildRunExpansionState> = {
  dispose: (expansions: ChildRunExpansionState): void => {
    expansions.abandonReads();
  },
  isClosed: (expansions: ChildRunExpansionState): boolean => expansions.isAbandoned,
};

/**
 * Hold one session's child-run expansions. The instance and its published mirror are both
 * session-scoped. The instance is a resource whose read lines a re-address must end, or the
 * session left behind keeps decoding expansions for rows nothing renders; the mirror is a value
 * a re-address simply replaces.
 */
export function useChildRunDisclosure(sessionId: string): ChildRunDisclosure {
  const bridge = usePlatformBridge();
  const held = useSubjectScopedResource(
    bridge,
    sessionId,
    () => new ChildRunExpansionState(),
    CHILD_RUN_EXPANSION_DISPOSAL,
  );
  const mirror = useSubjectScopedState<ReadonlyMap<RunId, ChildRunExpansion>>(
    bridge,
    sessionId,
    () => new Map<RunId, ChildRunExpansion>(),
  );
  const expansionState = held.value;
  const publishMirror = mirror.publish;
  const publish = useCallback(() => {
    publishMirror(
      new Map(
        [...expansionState.trackedChildRunIds].map((childRunId) => [
          childRunId,
          expansionState.expansionFor(childRunId),
        ]),
      ),
    );
  }, [expansionState, publishMirror]);
  const toggle = useCallback(
    (childRunId: RunId) => {
      if (expansionState.expansionFor(childRunId).status === "expanded") {
        expansionState.collapse(childRunId);
        publish();
        return;
      }
      // Expand before publishing: `expand` raises `expanding` synchronously and `publish`
      // snapshots the state at that moment. Publishing first would file the replaced state, so
      // against a slow daemon the row keeps offering an enabled `Expand` or `Retry`.
      const expanding = expansionState.expand(bridge, childRunId);
      publish();
      void expanding.then(publish, publish);
    },
    [bridge, expansionState, publish],
  );
  const expansions = mirror.value;
  const expansionFor = useCallback(
    (childRunId: RunId) => expansions.get(childRunId) ?? CHILD_RUN_SUMMARIZED,
    [expansions],
  );
  return useMemo(() => ({ expansionFor, toggle }), [expansionFor, toggle]);
}
