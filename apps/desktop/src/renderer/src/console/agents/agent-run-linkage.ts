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
 * Recency, as a comparable number. Newest is greatest; unstamped and unparseable
 * are least.
 *
 * THE STAMPS ARE PARSED RATHER THAN COMPARED AS TEXT. `touchedAt` is an ISO-8601
 * instant, and the event contract accepts a NUMERIC OFFSET as readily as `Z` — so
 * two stamps for the same instant can be two different strings, and two different
 * instants can sort the wrong way round: `10:00+02:00` is an hour EARLIER than
 * `09:00Z` and sorts after it in every lexical comparison. A linkage panel that
 * picked by text therefore read and displayed the wrong parent run, and kept doing
 * so for as long as both rows were in the projection.
 *
 * A stamp the platform cannot parse is the same answer as no stamp at all, and it
 * is deliberately not `NaN`: a comparison against `NaN` is false in both directions,
 * so a malformed row would win or lose by whichever end of the fold it landed on.
 * `-Infinity` puts it below every real instant while leaving it reachable when it is
 * the only row this agent has — which is the rule this selector already stated for
 * an unstamped row, now held for a row whose stamp the console cannot read either.
 */
function runRecency(touchedAt: string | undefined): number {
  if (touchedAt === undefined) {
    return Number.NEGATIVE_INFINITY;
  }
  const milliseconds = Date.parse(touchedAt);
  return Number.isNaN(milliseconds) ? Number.NEGATIVE_INFINITY : milliseconds;
}

/**
 * The newest run the session projects for one agent, where the log named one.
 *
 * `undefined` where no run has been attributed to this agent yet, which a linkage
 * surface renders as the absence it is rather than as an empty result. Newest is
 * decided by the projection's own `touchedAt` and by nothing this console invents:
 * a run row with no `touchedAt` — or with one the platform cannot parse — sorts
 * below every row that has a readable stamp rather than being dropped, so such a row
 * is still reachable when it is the only one.
 *
 * Ties keep the row already held, so the answer for two rows at the same instant is
 * decided by the projection's own order rather than by a re-reading of it.
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
    runRecency(candidate.touchedAt) > runRecency(newest.touchedAt) ? candidate : newest,
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
