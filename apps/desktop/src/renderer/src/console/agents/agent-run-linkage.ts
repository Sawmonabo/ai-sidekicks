// Which run is this agent's newest, and how a surface stays keyed by it.
//
// ONE HOME FOR ONE QUESTION. The child-link read is keyed by a PARENT RUN and
// every surface that asks it is scoped to an AGENT, so something has to relate the
// two — and the daemon answers no method that does. This module is where that
// relation lives, for every consumer: the pure selector over the store's own run
// projection, and the subscription that re-derives it. A second consumer keying
// the same question differently is the drift this file exists to prevent, which is
// why both sides of the seam are in one module and both leave through the family's
// door rather than by a deep import.
//
// WHY THE SUBSCRIPTION IS THE POINT AND NOT AN OPTIMISATION. The agent roster's
// push signal is filtered to the three registered agent-lifecycle kinds. A run
// starting emits none of them, so a caller that derived the parent run from a
// one-off snapshot read kept saying the agent had no run and never built its
// linkage read — for as long as that surface stayed open. `useSessionPartition` is
// the console's one subscription path, and the run partition's identity moves
// exactly when a run row is projected.
//
// THE CONTRACT A SECOND CONSUMER GETS
//
//   • `useNewestRunIdForAgent(sessionStore, agentId)` leaves through the family's
//     door and is the form a second consumer takes: the same answer, re-derived
//     whenever the run partition moves. Safe to call for an agent that has no run
//     and for an `agentId` that is `undefined`; both answer `undefined`, which is
//     an absence a surface renders rather than an empty result it fills in.
//   • `newestRunIdForAgent(sessionStore, agentId)` is the pure, synchronous form
//     over the store's CURRENT snapshot, and stays this family's own. A consumer
//     outside that took it would have to invent its own signal for re-deriving it,
//     which is exactly the defect above arrived at from the other side.
//
// Neither reads a bridge, and neither holds the answer: the value is derived from
// the store on every ask, so two consumers can never hold two copies of it.

import { useMemo } from "react";

import { useSessionPartition, type SessionStore } from "../store/index.js";

/**
 * The newest run the session projects for one agent, where the log named one.
 *
 * `undefined` where no run has been attributed to this agent yet, which a linkage
 * surface renders as the absence it is rather than as an empty result. Newest is
 * decided by the projection's own `touchedAt` and by nothing this console invents:
 * a run row with no `touchedAt` sorts below every row that has one rather than
 * being dropped, so an unstamped row is still reachable when it is the only one.
 */
export function newestRunIdForAgent(
  sessionStore: SessionStore,
  agentId: string | undefined,
): string | undefined {
  if (agentId === undefined) {
    return undefined;
  }
  const runs = Object.values(sessionStore.snapshot().partitions.run)
    .filter((run) => run !== undefined)
    .filter((run) => run.body?.["agentId"] === agentId);
  if (runs.length === 0) {
    return undefined;
  }
  return runs.reduce((newest, candidate) =>
    (candidate.touchedAt ?? "") > (newest.touchedAt ?? "") ? candidate : newest,
  ).id;
}

/**
 * The same answer, re-derived whenever the run partition moves.
 *
 * `runPartition` is a memo dependency rather than an argument: it is the value
 * whose identity says the projection changed, and the derivation reads the store's
 * current snapshot — which is the very map this subscription just observed.
 * Deriving from the partition here instead would be a second implementation of the
 * selector above, keyed differently and free to drift from it.
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
