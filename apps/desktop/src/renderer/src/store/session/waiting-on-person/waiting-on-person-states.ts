// Which event kinds open and close which waiting-on-person lifecycle, where each carries its
// identity, and how those compose into a key. `waiting-on-person-register.ts` holds the records.
//
// Every derivation is fail-closed: an event the wire did not identify is held open under a key of
// its own rather than dropped, and a state this build cannot name is not an attention state.
// Clearing a block that was never seen resolved is the defect the register exists to prevent.

import type { RunState } from "@ai-sidekicks/contracts";

import { structuralKey } from "@renderer/lib/structural-key.js";
import type { ProjectedSessionEvent } from "../entities/entities.js";

/** How the run-lifecycle taxonomy denormalizes a state onto its event type. */
export const RUN_STATE_EVENT_PREFIX = "run.";

/**
 * The run states that mean a person has to act. A failed run is included: it stopped and will
 * not start itself. Typed as `RunState` so the compiler rejects a state the contract lacks.
 */
export const ATTENTION_RUN_STATES: readonly RunState[] = [
  "waiting_for_approval",
  "waiting_for_input",
  "failed",
];

/**
 * The event kinds that put a run in the attention set. Derived from the states above so the
 * base-state and log vocabularies cannot disagree about which state needs a person. Every other
 * run-state kind takes the run out of it.
 */
export const ATTENTION_RUN_STATE_KINDS: readonly string[] = ATTENTION_RUN_STATES.map(
  (state) => `${RUN_STATE_EVENT_PREFIX}${state}`,
);

/** The payload member a run event carries its run's identity on. */
const RUN_CORRELATION_MEMBER = "runId";

/**
 * One request-scoped lifecycle: what opens it, what closes it, and where its id is. Reading
 * the wrong correlation member would open an ask that nothing could ever close.
 */
export interface RequestLifecycle {
  readonly openedBy: string;
  readonly closedBy: readonly string[];
  /** The payload member every event in this lifecycle carries the request id on. */
  readonly correlationMember: string;
}

/** The run a run-lifecycle event is about, or `undefined` where the wire named none. */
export function runIdOf(event: ProjectedSessionEvent): string | undefined {
  return correlationIdOf(event, RUN_CORRELATION_MEMBER);
}

/**
 * The approval and intervention lifecycles. A provider's permission ask opens an approval, so it
 * has none of its own.
 */
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
 * Whether a base-state entity's wire-verbatim state is one a person has to act on. A state this
 * build does not register is not one: better to miss it than call an unknown word a block.
 */
export function isAttentionRunState(state: string | undefined): boolean {
  return state !== undefined && (ATTENTION_RUN_STATES as readonly string[]).includes(state);
}

/**
 * The key an event takes when the wire named nothing that identifies it: its log position, so
 * the ask stays open. Dropping it would clear a block never seen resolved. Built through the same
 * encoder as every other key here, so it cannot collide with an identified ask.
 */
export function uncorrelatedKey(event: ProjectedSessionEvent): string {
  return structuralKey(["uncorrelated", event.sessionId, String(event.sequence)]);
}

/**
 * The key one request of this lifecycle is filed under, or `undefined` where the wire named
 * none. Namespaced by the opening event kind, because an approval id and an intervention id may
 * spell the same string.
 */
export function identifiedRequestKeyOf(
  event: ProjectedSessionEvent,
  lifecycle: RequestLifecycle,
): string | undefined {
  const requestId = correlationIdOf(event, lifecycle.correlationMember);
  return requestId === undefined ? undefined : structuralKey([lifecycle.openedBy, requestId]);
}

/**
 * Which request lifecycle, if any, this event belongs to. Matched on the event kind, never on
 * which correlation member the payload happens to carry.
 */
export function lifecycleFor(kind: string): RequestLifecycle | undefined {
  return REQUEST_LIFECYCLES.find(
    (lifecycle) => lifecycle.openedBy === kind || lifecycle.closedBy.includes(kind),
  );
}

// A non-string id is `undefined`, not coerced, so two different asks cannot both key on
// "[object Object]".
function correlationIdOf(event: ProjectedSessionEvent, member: string): string | undefined {
  const value = event.payload?.[member];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
