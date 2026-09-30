// What the wire calls a thing that is waiting on a person, and the key it is filed under.
//
// SEPARATE FROM THE REGISTER THAT READS IT because these are two different claims. This
// module says which event kinds open and close which lifecycle, which member each one
// carries its identity on, and how those parts compose into one key — every sentence a
// statement about the event taxonomy, checkable against the contracts event census
// and against nothing this console does. `outstanding-ask-journal.ts` says what a
// ledger of those lifecycles holds and how rows advance it, which is a statement about
// this console and about no wire at all.
//
// EVERY DERIVATION HERE IS FAIL-CLOSED IN THE SAME DIRECTION: an event the wire did not
// identify is held open under a key of its own rather than dropped, and a state this
// build cannot name is not an attention state. The register would rather carry an ask
// nobody can resolve than clear a block it never saw resolved — which is the defect the
// register exists to end, so its vocabulary may not reintroduce it one layer down.

import type { RunState } from "@ai-sidekicks/contracts";

import { structuralKey } from "@renderer/lib/structural-key.js";
import type { ProjectedSessionEvent } from "../entities/entities.js";

/** How the run-lifecycle taxonomy denormalizes a state onto its event type. */
export const RUN_STATE_EVENT_PREFIX = "run.";

/**
 * The run states that mean a person has to act, in the wire's own vocabulary.
 *
 * A failed run is here beside the two waiting states: it stopped and it will not start
 * itself. It leaves the set the same way the others do — by the run reaching a different
 * state — rather than by anything else in the session happening.
 *
 * Typed as `RunState` so a value the contract does not register fails to compile, which
 * is what lets the base-state seed below compare an entity's wire-verbatim `state`
 * against this set without a vocabulary of its own.
 */
export const ATTENTION_RUN_STATES: readonly RunState[] = [
  "waiting_for_approval",
  "waiting_for_input",
  "failed",
];

/**
 * Every run state, in the order the contract declares them.
 *
 * Typed as `RunState` so a state the contract does not register fails to compile —
 * which is the claim a runtime check could not make here, because parsing a wire value
 * in a console module is exactly what this console forbids.
 */
const RUN_STATES: readonly RunState[] = [
  "queued",
  "starting",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
  "paused",
  "completed",
  "interrupted",
  "failed",
];

/**
 * Every run state transition, DERIVED from the states above.
 *
 * The whole set and not just the attention subset, because a run leaves the attention
 * set by moving to ANY other state — `run.running` after an approval, `run.completed`,
 * `run.interrupted`. Derived rather than listed a second time so the kind and the state
 * cannot drift, and checked against the contracts event census by the co-located suite.
 */
export const RUN_STATE_KINDS: readonly string[] = RUN_STATES.map(
  (state) => `${RUN_STATE_EVENT_PREFIX}${state}`,
);

/**
 * The transitions that put a run in the attention set, DERIVED from the states above.
 *
 * Derived rather than listed a second time: the two sets are the same three facts in
 * two vocabularies — one the base state speaks and one the log speaks — and a hand-kept
 * copy is how they come to disagree about which state means somebody is needed.
 */
export const ATTENTION_RUN_STATE_KINDS: readonly string[] = ATTENTION_RUN_STATES.map(
  (state) => `${RUN_STATE_EVENT_PREFIX}${state}`,
);

/** The payload member a run event carries its run's identity on. */
const RUN_CORRELATION_MEMBER = "runId";

/**
 * One request-scoped lifecycle: what opens it, what closes it, and where its id is.
 *
 * A table rather than two `if` branches because the correlation member is the part
 * that must be right — an approval correlates on `approvalRequestId` and an intervention
 * on `interventionId`, and reading the wrong one would silently open an ask that nothing
 * could ever close. A provider's permission ask opens an approval, so it has no lifecycle
 * of its own.
 */
export interface RequestLifecycle {
  readonly openedBy: string;
  readonly closedBy: readonly string[];
  /**
   * The payload member every event in this lifecycle carries the request id on. Both ids
   * are minted by the daemon and unique within the session.
   */
  readonly correlationMember: string;
}

/**
 * The run a run-lifecycle event is about, or `undefined` where the wire named none.
 *
 * Here rather than at the call site so the member name is spelt once: a caller reading
 * the payload itself would be a second place that knows what a run event calls its run,
 * and the two would drift the first time the taxonomy moved.
 */
export function runIdOf(event: ProjectedSessionEvent): string | undefined {
  return correlationIdOf(event, RUN_CORRELATION_MEMBER);
}

export const REQUEST_LIFECYCLES: readonly RequestLifecycle[] = [
  {
    openedBy: "approval.requested",
    closedBy: ["approval.approved", "approval.rejected", "approval.canceled"],
    correlationMember: "approvalRequestId",
  },
  {
    openedBy: "intervention.requested",
    closedBy: [
      "intervention.accepted",
      "intervention.applied",
      "intervention.rejected",
      "intervention.degraded",
      "intervention.expired",
    ],
    correlationMember: "interventionId",
  },
];

/**
 * Whether a base-state entity's wire-verbatim state is one a person has to act on.
 *
 * Compared against the registered `RunState` set rather than parsed: a state this build
 * has never heard of is not an attention state, which is the fail-closed direction here
 * — the register would rather miss a state the console cannot name than assert that an
 * unknown word means somebody is needed.
 */
export function isAttentionRunState(state: string | undefined): boolean {
  return state !== undefined && (ATTENTION_RUN_STATES as readonly string[]).includes(state);
}

/**
 * The key an event takes when the wire named nothing that identifies it.
 *
 * FAIL-CLOSED, and the direction matters. An ask that arrived without a correlation id
 * cannot be matched to its own terminal, so it is held open under a key of its own: its position in the log, which is unique.
 * Dropping it instead would clear a block the console never saw resolved, which is the
 * exact failure this register exists to end. A resolution event missing one closes
 * nothing, for the same reason: it names no ask.
 *
 * Through the same encoder every other key here takes, so an unidentified ask and an
 * identified one cannot collide however a session id or an ask id happens to be spelt.
 */
export function uncorrelatedKey(event: ProjectedSessionEvent): string {
  return structuralKey(["uncorrelated", event.sessionId, String(event.sequence)]);
}

/**
 * The key one request of this lifecycle is filed under, or `undefined` where the wire
 * named nothing that identifies it.
 *
 * NAMESPACED BY THE EVENT THAT OPENS THE LIFECYCLE, because the two id spaces are two
 * wires: nothing says an approval request id and an intervention id cannot spell the
 * same string, and this one map holds both.
 */
export function identifiedRequestKeyOf(
  event: ProjectedSessionEvent,
  lifecycle: RequestLifecycle,
): string | undefined {
  const requestId = correlationIdOf(event, lifecycle.correlationMember);
  return requestId === undefined ? undefined : structuralKey([lifecycle.openedBy, requestId]);
}

/**
 * Which request lifecycle, if any, this event belongs to.
 *
 * Matched on the event KIND and never on which correlation member the payload happens to
 * carry.
 */
export function lifecycleFor(kind: string): RequestLifecycle | undefined {
  return REQUEST_LIFECYCLES.find(
    (lifecycle) => lifecycle.openedBy === kind || lifecycle.closedBy.includes(kind),
  );
}

/**
 * Read one correlation id off a payload, or `undefined`.
 *
 * A non-string is `undefined` rather than coerced: an id is what the wire says it is,
 * and stringifying whatever arrived would key two different asks on `"[object Object]"`
 * and let one close the other.
 */
function correlationIdOf(event: ProjectedSessionEvent, member: string): string | undefined {
  const value = event.payload?.[member];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
