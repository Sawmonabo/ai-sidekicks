// Which run this console's child-link read is keyed by, as a SUBSCRIPTION.
//
// The child-link read takes a parent run and this console is scoped to an agent, so
// the two are related through the store's own run projection. That derivation lives
// in `agents/` and this module does not repeat it — one implementation of "which
// run is this agent's newest", reached through that family's door.
//
// WHAT THIS MODULE ADDS IS THE SUBSCRIPTION, AND IT IS THE WHOLE POINT. The pane
// subscribes to the agent roster, whose push signal is filtered to the three
// registered agent-lifecycle kinds. A run starting emits none of them, so a mount
// that derived the parent run from a one-off snapshot read kept saying the agent
// had no run and never built its linkage read — for as long as the pane stayed
// open. `useSessionPartition` is the console's one subscription path, and the run
// partition's identity moves exactly when a run row is projected.

import { useMemo } from "react";

import { newestRunIdForAgent } from "../../agents/index.js";
import { useSessionPartition, type SessionStore } from "../../store/index.js";

/**
 * The newest run the session projects for this agent, re-derived whenever the run
 * partition moves.
 *
 * `runPartition` is a dependency rather than an argument: it is the value whose
 * identity says the projection changed, and the derivation reads the store's
 * current snapshot — which is the very map this subscription just observed.
 * Deriving from the partition here instead would be a second implementation of a
 * question `agents/` already answers, keyed differently and free to drift from it.
 */
export function useNewestRunIdForAgent(
  sessionStore: SessionStore,
  agentId: string | undefined,
): string | undefined {
  const runPartition = useSessionPartition(sessionStore, "run");
  return useMemo(
    () => newestRunIdForAgent(sessionStore, agentId),
    [sessionStore, agentId, runPartition],
  );
}
