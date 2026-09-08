// What the wire calls a thing that is waiting on a person, and the key it is filed under.
//
// SEPARATE FROM THE REGISTER THAT READS IT because these are two different claims. This
// module says which event kinds open and close which lifecycle, which member each one
// carries its identity on, and how those parts compose into one key — every sentence a
// statement about `Spec-006`'s taxonomy, checkable against the contracts event census
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

import { driverAskIdentitySegments, structuralKey } from "../../core/index.js";
import type { ConsoleSessionEvent } from "../entities.js";

/** How `Spec-006 §Run Lifecycle (run_lifecycle)` denormalizes a state onto its event type. */
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
 * The run a run-lifecycle event is about, or `undefined` where the wire named none.
 *
 * Here rather than at the call site so the member name is spelt once: a caller reading
 * the payload itself would be a second place that knows what a run event calls its run,
 * and the two would drift the first time the taxonomy moved.
 */
export function runIdOf(event: ConsoleSessionEvent): string | undefined {
  return correlationIdOf(event, RUN_CORRELATION_MEMBER);
}

/**
 * One request-scoped lifecycle: what opens it, what closes it, and where its id is.
 *
 * A table rather than three `if` branches because the correlation member is the part
 * that must be right — an approval correlates on `approvalRequestId`, a provider ask on
 * `askId`, an intervention on `interventionId`, and reading the wrong one would silently
 * open an ask that nothing could ever close.
 */
export interface RequestLifecycle {
  readonly openedBy: string;
  readonly closedBy: readonly string[];
  /** The payload member every event in this lifecycle carries the request id on. */
  readonly correlationMember: string;
  /**
   * The payload member that SCOPES that id, where the wire's id is not unique on its
   * own — absent where it is.
   *
   * Exactly one lifecycle carries one today and that is not a coincidence: an approval
   * request id and an intervention id are DAEMON-minted and unique within the session,
   * while an `askId` is the PROVIDER's, minted per provider session, so two runs blocked
   * at once legitimately raise the same one. Keyed on that id alone, either run's
   * terminal settled the single entry both had opened, and the bar printed its all-clear
   * line over a run still waiting on somebody.
   *
   * A second scoped lifecycle would be a second wire whose ids the daemon does not mint,
   * and the module that composes ITS segments would be named the way
   * `core/driver-ask-identity.ts` is.
   */
  readonly scopeMember?: string;
}

export const REQUEST_LIFECYCLES: readonly RequestLifecycle[] = [
  {
    openedBy: "approval.requested",
    closedBy: ["approval.approved", "approval.rejected", "approval.expired", "approval.canceled"],
    correlationMember: "approvalRequestId",
  },
  {
    openedBy: "driver_ask.requested",
    closedBy: ["driver_ask.responded", "driver_ask.expired", "driver_ask.canceled"],
    correlationMember: "askId",
    // `Spec-006` makes `runId` required on all four `driver_ask.*` shapes, which is what
    // makes the scope readable off the payload here rather than off a row this register
    // never sees.
    scopeMember: RUN_CORRELATION_MEMBER,
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
 * Read one correlation id off a payload, or `undefined`.
 *
 * A non-string is `undefined` rather than coerced: an id is what the wire says it is,
 * and stringifying whatever arrived would key two different asks on `"[object Object]"`
 * and let one close the other.
 */
function correlationIdOf(event: ConsoleSessionEvent, member: string): string | undefined {
  const value = event.payload?.[member];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The key an event takes when the wire named nothing that identifies it.
 *
 * FAIL-CLOSED, and the direction matters. An ask that arrived without a correlation id —
 * or, on a scoped lifecycle, without its scope — cannot be matched to its own terminal,
 * so it is held open under a key of its own: its position in the log, which is unique.
 * Dropping it instead would clear a block the console never saw resolved, which is the
 * exact failure this register exists to end. A resolution event missing either closes
 * nothing, for the same reason: it names no ask.
 *
 * Through the same encoder every other key here takes, so an unidentified ask and an
 * identified one cannot collide however a session id or an ask id happens to be spelt.
 */
export function uncorrelatedKey(event: ConsoleSessionEvent): string {
  return structuralKey(["uncorrelated", event.sessionId, String(event.sequence)]);
}

/**
 * The key one request of this lifecycle is filed under, or `undefined` where the wire
 * named nothing that identifies it.
 *
 * NAMESPACED BY THE EVENT THAT OPENS THE LIFECYCLE, because the three id spaces are
 * three wires: nothing says a daemon-minted intervention id and a provider-minted ask id
 * cannot spell the same string, and this one map holds all three.
 *
 * AND SCOPED WHERE THE LIFECYCLE SAYS ITS ID IS NOT UNIQUE ON ITS OWN. Which segments a
 * driver ask is identified by, and in which order, is `core/driver-ask-identity.ts`' and
 * is deliberately not spelled here — the ledger's ask card keys its own terminal fold on
 * the same pair, and one surface answering that question differently from the other is
 * how an answer given in one run settles a card in another.
 */
export function identifiedRequestKeyOf(
  event: ConsoleSessionEvent,
  lifecycle: RequestLifecycle,
): string | undefined {
  const requestId = correlationIdOf(event, lifecycle.correlationMember);
  if (lifecycle.scopeMember === undefined) {
    return requestId === undefined ? undefined : structuralKey([lifecycle.openedBy, requestId]);
  }
  const identitySegments = driverAskIdentitySegments(
    correlationIdOf(event, lifecycle.scopeMember),
    requestId,
  );
  return identitySegments === undefined
    ? undefined
    : structuralKey([lifecycle.openedBy, ...identitySegments]);
}

/**
 * Which request lifecycle, if any, this event belongs to.
 *
 * Matched on the event KIND and never on which correlation member the payload happens to
 * carry: `Spec-006 §Approval Flow (approval_flow)` puts `askId` on `approval.requested`
 * as well, so a payload-first match would open a provider ask that no `driver_ask.*`
 * terminal could ever close.
 */
export function lifecycleFor(kind: string): RequestLifecycle | undefined {
  return REQUEST_LIFECYCLES.find(
    (lifecycle) => lifecycle.openedBy === kind || lifecycle.closedBy.includes(kind),
  );
}
