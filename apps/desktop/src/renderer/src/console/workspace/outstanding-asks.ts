// What is still waiting on a person, folded by its own lifecycle.
//
// `Spec-023 §The surface set` puts the all-clear line on the cast bar "when nothing is
// amber or red". Deciding that from each participant's NEWEST row cannot work in a
// session with more than one run: an agent waiting on an
// approval in run A that then emits an ordinary row from run B has a newer row that
// is not amber, and the bar says "Nothing needs you" over a run that is still
// blocked. The newest row answers "what is this actor doing"; it does not answer
// "what is still outstanding", and those are different questions over the same log.
//
// So an ask is opened by its own event and closed by its own terminal, and nothing
// else clears it. Two lifecycles, because the wire has two shapes:
//
//   • **Request-scoped** — an approval, a provider ask, an intervention. Each is
//     opened by its `.requested` event and closed by any of its resolution events
//     carrying the same id. An unresolved request stays outstanding for as long as
//     the log says it is unresolved, which is exactly the guarantee the old rule
//     could not make.
//   • **Run-scoped** — a run's own state. `Spec-006 §Run Lifecycle (run_lifecycle)`
//     denormalizes the state onto the event type, and the nine state transitions are
//     mutually exclusive, so the run's LATEST transition is its state. A run is
//     outstanding while that state is one a person has to act on; a later transition
//     on the same run replaces it, and a transition on a different run does not.
//
// The identity that carries is the OPENER's. A resolution event is authored by
// whoever resolved it — an approver is not the participant who was blocked — so the
// participant an ask is attributed to is read once, when the ask opens.
//
// Every kind below is a registered `SessionEventType`; the co-located test checks
// each one against the contracts census, so an ask keyed on a kind the wire does not
// have cannot ship.

import type { ConsoleSessionEvent } from "../store/index.js";

/**
 * The run states that mean a person has to act.
 *
 * A failed run is here beside the two waiting states: it stopped and it will not
 * start itself. It leaves the set the same way the others do — by the run reaching
 * a different state — rather than by anything else in the session happening.
 */
export const ATTENTION_RUN_STATE_KINDS: readonly string[] = [
  "run.waiting_for_approval",
  "run.waiting_for_input",
  "run.failed",
];

/**
 * Every run state transition, in the order the wire declares them.
 *
 * The whole set and not just the attention subset, because a run leaves the
 * attention set by moving to ANY other state — `run.running` after an approval,
 * `run.completed`, `run.interrupted`. Written as one closed set so a reader can see
 * that the two above are a subset of it rather than a parallel vocabulary.
 */
export const RUN_STATE_KINDS: readonly string[] = [
  "run.queued",
  "run.starting",
  "run.running",
  "run.waiting_for_approval",
  "run.waiting_for_input",
  "run.paused",
  "run.completed",
  "run.interrupted",
  "run.failed",
];

/**
 * One request-scoped lifecycle: what opens it, what closes it, and where its id is.
 *
 * A table rather than three `if` branches because the correlation member is the part
 * that must be right — an approval correlates on `approvalRequestId`, a provider ask
 * on `askId`, an intervention on `interventionId`, and reading the wrong one would
 * silently open an ask that nothing could ever close.
 */
export interface RequestLifecycle {
  readonly openedBy: string;
  readonly closedBy: readonly string[];
  /** The payload member every event in this lifecycle carries the request id on. */
  readonly correlationMember: string;
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

/** The payload member a run event carries its run's identity on. */
const RUN_CORRELATION_MEMBER = "runId";

/**
 * Read one correlation id off a payload, or `undefined`.
 *
 * A non-string is `undefined` rather than coerced: an id is what the wire says it
 * is, and stringifying whatever arrived would key two different asks on `"[object
 * Object]"` and let one close the other.
 */
function correlationIdOf(event: ConsoleSessionEvent, member: string): string | undefined {
  const value = event.payload?.[member];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The key an opening event takes when the wire named no id for it.
 *
 * FAIL-CLOSED, and the direction matters. An ask that arrived without a correlation
 * id cannot be matched to its own terminal, so it is held open under a key of its own
 * — its position in the log, which is unique. Dropping it instead would clear a block
 * the console never saw resolved, which is the exact failure this fold exists to end.
 * A resolution event with no id closes nothing, for the same reason: it names no ask.
 */
function uncorrelatedKey(event: ConsoleSessionEvent): string {
  return `uncorrelated:${event.sessionId}:${String(event.sequence)}`;
}

/**
 * Which request lifecycle, if any, this event belongs to.
 *
 * Matched on the event KIND and never on which correlation member the payload
 * happens to carry: `Spec-006 §Approval Flow (approval_flow)` puts `askId` on `approval.requested`
 * as well, so a payload-first match would open a provider ask that no
 * `driver_ask.*` terminal could ever close.
 */
function lifecycleFor(kind: string): RequestLifecycle | undefined {
  return REQUEST_LIFECYCLES.find(
    (lifecycle) => lifecycle.openedBy === kind || lifecycle.closedBy.includes(kind),
  );
}

/**
 * What the session still has open.
 *
 * The COUNT is carried beside the participant set rather than derived from it,
 * because they answer different questions and the difference is load-bearing: an ask
 * the wire attributed to nobody puts no chip in amber and still means something is
 * outstanding. The all-clear line reads the count, so it can never say "nothing
 * needs you" over an unattributed ask that no chip could have shown.
 */
export interface OutstandingAsks {
  /** Participants an outstanding ask is attributed to, by its OPENING event. */
  readonly participantIds: ReadonlySet<string>;
  /** Every outstanding ask, attributed or not. */
  readonly count: number;
}

/**
 * Fold the whole log into what is still open.
 *
 * A pure function over the log rather than a class, for the reason every other
 * derivation in this family is: it holds nothing between calls, so a re-fold after a
 * batch cannot disagree with a fold from scratch.
 */
export function foldOutstandingAsks(timeline: readonly ConsoleSessionEvent[]): OutstandingAsks {
  const openerByRequestKey = new Map<string, string | undefined>();
  const runStateByRunId = new Map<string, { readonly kind: string; readonly opener?: string }>();

  for (const event of timeline) {
    if (RUN_STATE_KINDS.includes(event.kind)) {
      const runKey = correlationIdOf(event, RUN_CORRELATION_MEMBER) ?? uncorrelatedKey(event);
      runStateByRunId.set(runKey, {
        kind: event.kind,
        ...(event.actorId === undefined ? {} : { opener: event.actorId }),
      });
      continue;
    }
    const lifecycle = lifecycleFor(event.kind);
    if (lifecycle === undefined) {
      continue;
    }
    const requestId = correlationIdOf(event, lifecycle.correlationMember);
    if (event.kind === lifecycle.openedBy) {
      openerByRequestKey.set(
        `${lifecycle.openedBy}:${requestId ?? uncorrelatedKey(event)}`,
        event.actorId,
      );
    } else if (requestId !== undefined) {
      openerByRequestKey.delete(`${lifecycle.openedBy}:${requestId}`);
    }
  }

  const participantIds = new Set<string>();
  let count = openerByRequestKey.size;
  for (const opener of openerByRequestKey.values()) {
    if (opener !== undefined) {
      participantIds.add(opener);
    }
  }
  for (const runState of runStateByRunId.values()) {
    if (!ATTENTION_RUN_STATE_KINDS.includes(runState.kind)) {
      continue;
    }
    count += 1;
    if (runState.opener !== undefined) {
      participantIds.add(runState.opener);
    }
  }
  return { participantIds, count };
}
