// What a narrowed `daemon.subscribe` stream hands a subscriber.
// `services/daemon/session/event/streams.ts` says which beats reach a subscription; this module
// says what reaches it.
//
// The two run streams deliver frames of changes, each a registered projection
// (`RunStateChangeEvent`, `AgentRunRolledBackEvent`, `QueueItemSummary`) at its beat's cursor, not
// the session envelope: a projection has a top-level `newState`, not `payload.newState`, and no
// `kind` or `sequence`. A fixture that handed over the envelope would make every end-to-end result
// about a frame no daemon produces. Codex's safety hold is a live frame with no session row, so no
// beat projects to it.
//
// Every member is sourced from the beat, not invented. `occurredAt` becomes the state-change
// `timestamp` and the queue row's `updatedAt`, and the beat's kind supplies the queue state
// through the same table that routed it. A beat that cannot supply a required member is refused by
// name, not delivered half-built. `QueueItemSummary` projects the `queue_items` row, which the
// queue payload (`{sessionId, queueItemId, state}`) does not carry, so `position`, `content` and
// `createdAt` come from the caller's row lookup.
//
// Every composed candidate is checked with its shape's generated check before delivery and a
// failure is a refusal with the failing member's path. Hand-checking required members and casting
// would leave optionals such as `intendedClose` unchecked; the run-lifecycle kinds register no
// payload variant for the scenario contract check to read, so nothing else catches it. The check
// also removes the branded-identifier casts. The value import of the checks costs the release
// bundle nothing: this module is reached only from the fixture bridge, and the fixture composition
// sits behind the build-time `__FIXTURE_BUILD__` branch in `App.tsx`. `projection.ts` holds what
// all arms share, and `lib/wire/strings.ts` the string reader every wire reader uses.

import {
  validateAgentRunRolledBackEvent,
  validateRunStateChangeEvent,
  type AgentRunRolledBackEvent,
  type RunStateChangeEvent,
} from "@ai-sidekicks/contracts/run/control";
import { validateQueueItemSummary, type QueueItemSummary } from "@ai-sidekicks/contracts/run/queue";

import { readWireString } from "#renderer/lib/wire/strings.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import {
  carriedOptionalMembers,
  projectThroughRegisteredShape,
  refuseSessionDisagreement,
  unprojectable,
  unprojectableFor,
} from "./projection.js";
import type { RunStreamProjection, RunStreamUnprojectable } from "./projection.js";
import { RUN_QUEUE_EVENT_STREAM, RUN_STATE_EVENT_STREAM } from "#shared/daemon/streams.js";
import { runStateForTransitionKind } from "#renderer/store/session/events/run/state-kinds.js";
import {
  runQueueStreamStateFor,
  runStateStreamArmFor,
} from "../daemon/session/event/stream-kinds.js";

/** What the `agent.run.subscribe` stream delivers: a state change, or the forward rollback row. */
export type RunStateStreamDelivery = RunStateChangeEvent | AgentRunRolledBackEvent;

/**
 * One change of a narrowed run stream's frame as the fixture composes it, carrying the beat's
 * cursor wire-verbatim: a state-stream `event`, or a queue-stream `item`.
 */
export type ScenarioRunStreamChange =
  | { readonly cursor: string; readonly event: RunStateStreamDelivery }
  | { readonly cursor: string; readonly item: QueueItemSummary };

/** What one beat projects to as a change of its narrowed stream's frame. */
export type ScenarioRunStreamChangeProjection =
  | { readonly status: "projected"; readonly change: ScenarioRunStreamChange }
  | RunStreamUnprojectable;

/** Every member any arm of the union `Shape` declares, not only the members all arms share. */
type MemberOfAnyArm<Shape> = Shape extends unknown ? keyof Shape : never;

/**
 * The optional `RunStateChangeEvent` members this projection carries through, wire-verbatim, so a
 * scenario's `trigger` or `processExit` is not flattened away. Keyed by the derived member union
 * so a member added to the registered shape fails to compile; the check decides whether a value is
 * accepted.
 */
const RUN_STATE_CHANGE_CARRIED_OPTIONAL_MEMBERS: Readonly<
  Record<
    Exclude<
      MemberOfAnyArm<RunStateChangeEvent>,
      "runId" | "runVersion" | "previousState" | "newState" | "timestamp"
    >,
    true
  >
> = {
  failureCategory: true,
  failureCause: true,
  recoveryCondition: true,
  providerFailureDetail: true,
  processExit: true,
  intendedClose: true,
  executionPosture: true,
  trigger: true,
};

/**
 * The `QueueItemSummary` members, beyond the row's own columns, carried through from the queue row
 * where it names them: the message's files, the child whose queue holds it, whether it is sent now,
 * what kind of item it is and where it goes, its plan message, and why its delivery failed. Keyed
 * by the derived member union like the table above.
 */
const QUEUE_ROW_CARRIED_OPTIONAL_MEMBERS: Readonly<
  Record<
    Exclude<
      MemberOfAnyArm<QueueItemSummary>,
      "id" | "state" | "position" | "content" | "createdAt" | "updatedAt"
    >,
    true
  >
> = {
  attachments: true,
  childHandle: true,
  isSentNow: true,
  kind: true,
  target: true,
  planMessage: true,
  notDeliveredReason: true,
};

/** The registered payload one beat travels as on the `agent.run.subscribe` stream. */
export function projectRunStateStreamDelivery(
  event: ProjectedSessionEvent,
): RunStreamProjection<RunStateStreamDelivery> {
  return projectRunStateStreamBeat(event);
}

/**
 * The change one beat carries on a narrowed run stream's frame, at the beat's cursor, or
 * `undefined` when the subscription is not one of the two narrowed run streams; `session.subscribe`
 * and bare event-type names get the envelope. `queueRowFor` finds the queue row by the beat's own
 * queue item id, and a lookup that finds none is a refusal rather than a made-up row.
 */
export function projectRunStreamChange(
  subscriptionName: string,
  event: ProjectedSessionEvent,
  queueRowFor: QueueRowLookup,
): ScenarioRunStreamChangeProjection | undefined {
  if (subscriptionName === RUN_STATE_EVENT_STREAM) {
    const projection = projectRunStateStreamBeat(event);
    return projection.status === "projected"
      ? { status: "projected", change: { cursor: event.cursor, event: projection.delivery } }
      : projection;
  }
  if (subscriptionName === RUN_QUEUE_EVENT_STREAM) {
    const projection = projectRunQueueStreamBeat(event, queueRowFor);
    return projection.status === "projected"
      ? { status: "projected", change: { cursor: event.cursor, item: projection.delivery } }
      : projection;
  }
  return undefined;
}

/** Finds one queue row by its queue item id, or `undefined` where there is none. */
type QueueRowLookup = (queueItemId: string) => Readonly<Record<string, unknown>> | undefined;

/** The `agent.run.subscribe` arms: a state transition, or the forward rollback row. */
function projectRunStateStreamBeat(
  event: ProjectedSessionEvent,
): RunStreamProjection<RunStateStreamDelivery> {
  // The arm comes from the routing table, which is what decided this beat reaches this stream, so
  // it cannot disagree with the routing.
  const arm = runStateStreamArmFor(event.kind);
  if (arm === undefined) {
    return unprojectable(
      `"${event.kind}" is not a kind the run-state stream ` +
        `carries, so it has no registered arm to project into.`,
    );
  }
  return arm === "rollback" ? projectRollback(event) : projectStateChange(event);
}

/** `RunStateChangeEvent` — the canonical transitions. */
function projectStateChange(
  event: ProjectedSessionEvent,
): RunStreamProjection<RunStateChangeEvent> {
  const payload = event.payload;
  if (payload === undefined) {
    return unprojectableFor(event, "carries no payload at all");
  }
  const sessionDisagreement = refuseSessionDisagreement(event, payload);
  if (sessionDisagreement !== undefined) {
    return sessionDisagreement;
  }
  // The kind and the payload each name the state the run is now in, and they must agree. Checked
  // before the check because an `agent.run.running` frame reporting `paused` passes the registered
  // vocabulary and then routes by one key and renders by the other.
  const announcedState = runStateForTransitionKind(event.kind);
  const statedState = payload["newState"];
  if (statedState === undefined) {
    return unprojectableFor(event, "names no `newState` for the run state it announces");
  }
  if (statedState !== announcedState) {
    return unprojectableFor(
      event,
      `announces "${String(announcedState)}" by its kind and ${JSON.stringify(statedState)} ` +
        `in its payload; one beat cannot report two current states`,
    );
  }
  return projectThroughRegisteredShape(validateRunStateChangeEvent, event, {
    // Optionals are spread first so a payload cannot displace a required member by spelling it
    // under an optional's name.
    ...carriedOptionalMembers(payload, RUN_STATE_CHANGE_CARRIED_OPTIONAL_MEMBERS),
    runId: payload["runId"],
    runVersion: payload["runVersion"],
    previousState: payload["previousState"],
    newState: statedState,
    timestamp: event.occurredAt,
  });
}

/** `AgentRunRolledBackEvent` — the forward, non-state arm of the same stream. */
function projectRollback(
  event: ProjectedSessionEvent,
): RunStreamProjection<AgentRunRolledBackEvent> {
  const payload = event.payload;
  if (payload === undefined) {
    return unprojectableFor(event, "carries no payload at all");
  }
  const sessionDisagreement = refuseSessionDisagreement(event, payload);
  if (sessionDisagreement !== undefined) {
    return sessionDisagreement;
  }
  return projectThroughRegisteredShape(validateAgentRunRolledBackEvent, event, {
    // The payload's own session, already checked equal to the envelope's. Copying the envelope's
    // here would make that check vacuous.
    sessionId: payload["sessionId"],
    runId: payload["runId"],
    runVersion: payload["runVersion"],
    targetPosition: payload["targetPosition"],
  });
}

/** `QueueItemSummary` — what `agent.queueItem.subscribe` streams for one queue row. */
function projectRunQueueStreamBeat(
  event: ProjectedSessionEvent,
  queueRowFor: QueueRowLookup,
): RunStreamProjection<QueueItemSummary> {
  const announcedState = runQueueStreamStateFor(event.kind);
  if (announcedState === undefined) {
    return unprojectable(
      `"${event.kind}" is not a queue row the queue ` +
        `stream carries, so it announces no queue state.`,
    );
  }
  const payload = event.payload;
  if (payload === undefined) {
    return unprojectableFor(event, "carries no payload at all");
  }
  const sessionDisagreement = refuseSessionDisagreement(event, payload);
  if (sessionDisagreement !== undefined) {
    return sessionDisagreement;
  }
  const queueItemId = readWireString(payload["queueItemId"]);
  if (queueItemId === undefined) {
    return unprojectableFor(event, "names no `queueItemId` to find its queue row by");
  }
  // Required like `newState` on the state arm: every queue event's payload is
  // `{sessionId, queueItemId, state}`. Skipping the comparison when absent would let the summary
  // take its state from the kind alone and deliver a payload the contract rejects.
  const statedState = payload["state"];
  if (statedState === undefined) {
    return unprojectableFor(
      event,
      "names no `state` for the queue state its kind announces to be checked against",
    );
  }
  if (statedState !== announcedState) {
    return unprojectableFor(
      event,
      `announces "${announcedState}" by its kind and ${JSON.stringify(statedState)} ` +
        `in its payload; one beat cannot report two queue states`,
    );
  }
  // The row, not the beat: `QueueItemSummary` projects `queue_items`, which carries members the
  // registered queue payload does not.
  const queueRow = queueRowFor(queueItemId);
  if (queueRow === undefined) {
    return unprojectableFor(
      event,
      `is about queue item "${queueItemId}", for which no queue row was found ` +
        `— and the row is where \`position\`, \`content\` and \`createdAt\` live`,
    );
  }
  return projectThroughRegisteredShape(validateQueueItemSummary, event, {
    ...carriedOptionalMembers(queueRow, QUEUE_ROW_CARRIED_OPTIONAL_MEMBERS),
    id: queueItemId,
    state: announcedState,
    // Row members carried through untouched; their types are the schema's business.
    position: queueRow["position"],
    content: queueRow["content"],
    createdAt: queueRow["createdAt"],
    // This beat is the row's newest change, so its moment is the row's last update.
    updatedAt: event.occurredAt,
  });
}
