// What a narrowed `daemon.subscribe` stream hands a subscriber. `session-event-streams.ts` says
// which beats reach a subscription; this module says what reaches it.
//
// The two `run.*` streams deliver registered projections (`RunStateChangeEvent`,
// `RunRolledBackEvent`, `QueueItemSummary`), not the session envelope: they have a top-level
// `newState`, not `payload.newState`, and no `kind` or `sequence`. A fixture that handed over the
// envelope would make every end-to-end result about a frame no daemon produces.
// Codex's safety hold is a live frame with no session row, so no beat projects to it.
//
// Every member is sourced from the beat, not invented. `occurredAt` becomes the state-change
// `timestamp` and the queue row's `updatedAt`, and the beat's kind supplies the queue state
// through the same table that routed it. A beat that cannot supply a required member is refused by
// name, not delivered half-built. `QueueItemSummary` projects the `queue_items` row, which the
// queue payload (`{sessionId, queueItemId, state}`) does not carry, so `priority`, `content` and
// `createdAt` come from the caller's row lookup.
//
// Every composed candidate is parsed through the registered schema before delivery and a failure
// is a refusal with the failing member's path. Hand-checking required members and casting would
// leave optionals such as `intendedClose` unchecked; the run-lifecycle kinds register no payload
// variant for the scenario contract check to read, so nothing else catches it. Parsing also removes
// the branded-identifier casts. The value import of the schemas costs the release bundle nothing:
// this module is reached only from the fixture bridge, and the fixture composition sits behind
// the build-time `__FIXTURE_BUILD__` branch in `App.tsx`. `shapes.ts` holds what all
// arms share, and `lib/wire/strings.ts` the string reader every wire reader uses.

import { QueueItemSummarySchema } from "@ai-sidekicks/contracts/run/queue";
import {
  RunRolledBackEventSchema,
  RunStateChangeEventSchema,
} from "@ai-sidekicks/contracts/run/control";
import type { QueueItemSummary } from "@ai-sidekicks/contracts/run/queue";
import type { RunStateChangeEvent } from "@ai-sidekicks/contracts/run/control";

import { readWireString } from "#renderer/lib/wire/strings.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/entities.js";
import {
  carriedOptionalMembers,
  projectThroughRegisteredShape,
  refuseSessionDisagreement,
  unprojectable,
  unprojectableFor,
} from "./shapes.js";
import type { RunStreamProjection } from "./shapes.js";
import {
  RUN_QUEUE_EVENT_STREAM,
  RUN_STATE_EVENT_STREAM,
} from "../daemon/session/event/session-event-streams.js";
import { runStateForTransitionKind } from "#renderer/store/session-events/run/state-kinds.js";
import {
  runQueueStreamStateFor,
  runStateStreamArmFor,
} from "../daemon/session/event/stream-kinds.js";

/**
 * The optional `RunStateChangeEvent` members this projection carries through, wire-verbatim, so a
 * scenario's `completionKind` or `trigger` is not flattened away. Keyed by the derived member union
 * so a member added to the registered shape fails to compile; the parse decides whether a value is
 * accepted.
 */
const RUN_STATE_CHANGE_CARRIED_OPTIONAL_MEMBERS: Readonly<
  Record<
    Exclude<
      keyof RunStateChangeEvent,
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
  completionKind: true,
  intendedClose: true,
  executionPosture: true,
  trigger: true,
};

/**
 * The optional `QueueItemSummary` members carried through from the queue row where it names them:
 * the message's files, the child whose queue holds it, and the reason its delivery failed. Keyed
 * by the derived member union like the table above.
 */
const QUEUE_ROW_CARRIED_OPTIONAL_MEMBERS: Readonly<
  Record<
    Exclude<
      keyof QueueItemSummary,
      "id" | "state" | "priority" | "content" | "createdAt" | "updatedAt"
    >,
    true
  >
> = {
  attachments: true,
  childHandle: true,
  notDeliveredReason: true,
};

/**
 * The registered payload this beat travels as on this stream, or `undefined` when the subscription
 * is not one of the two narrowed run streams; `session.subscribe` and bare event-type names get the
 * envelope. `queueRowFor` finds the queue row by the beat's own queue item id, and a lookup that
 * finds none is a refusal rather than a made-up row.
 */
export function projectRunStreamDelivery(
  subscriptionName: typeof RUN_STATE_EVENT_STREAM,
  event: ProjectedSessionEvent,
): RunStreamProjection;
/** The same delivery for a name known only at run time, with the queue row lookup. */
export function projectRunStreamDelivery(
  subscriptionName: string,
  event: ProjectedSessionEvent,
  queueRowFor: QueueRowLookup,
): RunStreamProjection | undefined;
/** Routes a beat to the arm its narrowed stream registers. */
export function projectRunStreamDelivery(
  subscriptionName: string,
  event: ProjectedSessionEvent,
  queueRowFor?: QueueRowLookup,
): RunStreamProjection | undefined {
  if (subscriptionName === RUN_STATE_EVENT_STREAM) {
    return projectRunStateStreamBeat(event);
  }
  if (subscriptionName === RUN_QUEUE_EVENT_STREAM && queueRowFor !== undefined) {
    return projectRunQueueStreamBeat(event, queueRowFor);
  }
  return undefined;
}

/** Finds one queue row by its queue item id, or `undefined` where there is none. */
type QueueRowLookup = (queueItemId: string) => Readonly<Record<string, unknown>> | undefined;

/** The `run.subscribeState` arms: a state transition, or the forward rollback row. */
function projectRunStateStreamBeat(event: ProjectedSessionEvent): RunStreamProjection {
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
function projectStateChange(event: ProjectedSessionEvent): RunStreamProjection {
  const payload = event.payload;
  if (payload === undefined) {
    return unprojectableFor(event, "carries no payload at all");
  }
  const sessionDisagreement = refuseSessionDisagreement(event, payload);
  if (sessionDisagreement !== undefined) {
    return sessionDisagreement;
  }
  // The kind and the payload each name the state the run is now in, and they must agree. Checked
  // before the parse because a `run.running` frame reporting `paused` passes the registered
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
  return projectThroughRegisteredShape(RunStateChangeEventSchema, event, {
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

/** `RunRolledBackEvent` — the forward, non-state arm of the same stream. */
function projectRollback(event: ProjectedSessionEvent): RunStreamProjection {
  const payload = event.payload;
  if (payload === undefined) {
    return unprojectableFor(event, "carries no payload at all");
  }
  const sessionDisagreement = refuseSessionDisagreement(event, payload);
  if (sessionDisagreement !== undefined) {
    return sessionDisagreement;
  }
  return projectThroughRegisteredShape(RunRolledBackEventSchema, event, {
    // The payload's own session, already checked equal to the envelope's. Copying the envelope's
    // here would make that check vacuous.
    sessionId: payload["sessionId"],
    runId: payload["runId"],
    runVersion: payload["runVersion"],
    targetPosition: payload["targetPosition"],
  });
}

/** `QueueItemSummary` — what `run.subscribeQueue` streams for one queue row. */
function projectRunQueueStreamBeat(
  event: ProjectedSessionEvent,
  queueRowFor: QueueRowLookup,
): RunStreamProjection {
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
        `— and the row is where \`priority\`, \`content\` and \`createdAt\` live`,
    );
  }
  return projectThroughRegisteredShape(QueueItemSummarySchema, event, {
    ...carriedOptionalMembers(queueRow, QUEUE_ROW_CARRIED_OPTIONAL_MEMBERS),
    id: queueItemId,
    state: announcedState,
    // Row members carried through untouched; their types are the schema's business. `priority` may
    // be negative, since a negative value is a deliberate de-prioritization.
    priority: queueRow["priority"],
    content: queueRow["content"],
    createdAt: queueRow["createdAt"],
    // This beat is the row's newest change, so its moment is the row's last update.
    updatedAt: event.occurredAt,
  });
}
