import { useCallback, useMemo } from "react";

import { type RunId } from "@ai-sidekicks/contracts";

import { useConsoleBridge } from "@renderer/services/platform/hooks/usePlatformBridge.js";
import { useSessionScopedState } from "@renderer/console/seats/index.js";
import { useSubjectScopedResource } from "@renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import { type SubjectScopedDisposal } from "@renderer/lib/subject-scoped/subject-scoped-disposal.js";
import {
  CHILD_RUN_SUMMARIZED,
  ChildRunExpansionState,
  type ChildRunDisclosure,
  type ChildRunExpansion,
} from "../child-run-expansion.js";

/**
 * How a session's expansions end, stated once so the render hands over a stable pair.
 *
 * TERMINAL RATHER THAN RELEASING: the object holds one read line per child run, and a
 * line that was let go of is not a line the next render may open a round on.
 * `isAbandoned` is what makes React's double-mount survivable — the disposed object is
 * recognised and a fresh one minted, rather than every later press being born over.
 */
const CHILD_RUN_EXPANSION_DISPOSAL: SubjectScopedDisposal<ChildRunExpansionState> = {
  dispose: (expansions: ChildRunExpansionState): void => {
    expansions.abandonReads();
  },
  isClosed: (expansions: ChildRunExpansionState): boolean => expansions.isAbandoned,
};

/**
 * Hold one session's child-run expansions.
 *
 * The instance AND its published mirror are both session-scoped, for
 * `useRunGroupDisclosure`'s reason: they are one fact, and re-seeding the instance
 * alone would leave the mirror standing over a session it is not about.
 *
 * The instance is a RESOURCE and the mirror is a value, which is the one asymmetry
 * here: the mirror is a map a re-address simply replaces, and the instance owns read
 * lines that a re-address has to END — otherwise the session left behind goes on
 * decoding expansions for rows nothing is rendering.
 */
export function useChildRunDisclosure(sessionId: string): ChildRunDisclosure {
  const bridge = useConsoleBridge();
  const held = useSubjectScopedResource(
    bridge,
    sessionId,
    () => new ChildRunExpansionState(),
    CHILD_RUN_EXPANSION_DISPOSAL,
  );
  const mirror = useSessionScopedState<ReadonlyMap<RunId, ChildRunExpansion>>(
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
      // STARTED BEFORE THE PUBLICATION, and the order is the whole of it. `expand`
      // raises `expanding` synchronously and `publish` SNAPSHOTS whatever the state
      // holds when it runs, so publishing first files the state this press replaced:
      // against a daemon that is slow or never answers, the row goes on offering an
      // enabled `Expand` — or `Retry` — with no later publication until settlement,
      // and its disabled progress state is unreachable. `useEarlierHistory`
      // makes the same claim about its own in-flight flag and can settle first only
      // because its state is DERIVED from the reader at render rather than copied at
      // the call; a mirror has to be filled after the fact it mirrors is true.
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
