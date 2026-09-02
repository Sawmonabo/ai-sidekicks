// What a narrowed `daemon.subscribe` stream actually hands a subscriber.
//
// `session-event-streams.ts` answers WHICH beats reach a subscription. This module
// answers WHAT reaches it, and the two are different questions with different
// failure modes: routing is wrong when a surface receives a frame the daemon would
// not have sent it, and this is wrong when a surface receives the right frame in a
// shape the daemon does not send at all.
//
// THE DEFECT THIS REPLACES. The fixture handed every subscriber the renderer-local
// `ConsoleSessionEvent` envelope — `{id, sessionId, sequence, kind, occurredAt,
// payload}`. The two `run.*` streams are registered PROJECTIONS and carry nothing
// of the sort: `run.subscribeState` streams `RunStateChangeEvent | RunRolledBackEvent`
// and `run.subscribeQueue` streams `QueueItemSummary`, none of which has a `kind`,
// a `sequence`, or a nested `payload`, and all of which name members the envelope
// does not. So a runs surface built against the fixture would read `event.payload
// .newState` where the wire sends `currentState`, and every screenshot, geometry
// reading, and end-to-end result taken against it would have been about a frame no
// daemon produces.
//
// WHERE THE MEMBERS COME FROM. Each one is sourced from the beat and nothing is
// composed: `newState` becomes `currentState`, the envelope's `occurredAt` becomes
// the state-change `timestamp` and the queue row's `updatedAt`, and the beat's own
// KIND supplies the queue state through the same table that routed it here. A beat
// that cannot supply a required member is REFUSED — loudly, by name, through the
// fixture's own refusal vocabulary — rather than delivered half-built, because a
// projection missing a required member is exactly the shape a surface renders as
// blank and a reviewer reads as working.
//
// WHY THE CONTRACTS IMPORT IS TYPE-ONLY. The renderer's initial-bundle budget is
// enforced, and a value import of the run-control module would pull its Zod schemas
// and their transitive census into the console. The registered shapes are therefore
// consumed as TYPES here — which is what makes a missing required member a compile
// error rather than a hope — and the co-located suite parses these projections
// through the real `RunStateChangeEventSchema` / `RunRolledBackEventSchema` /
// `QueueItemSummarySchema`, because a test file is not bundled and can afford to.

import type {
  ChannelId,
  QueueItemId,
  QueueItemState,
  QueueItemSummary,
  RunId,
  RunRolledBackEvent,
  RunState,
  RunStateChangeEvent,
  SessionId,
} from "@ai-sidekicks/contracts";

import type { ConsoleSessionEvent } from "../store/index.js";
import {
  RUN_QUEUE_EVENT_STREAM,
  RUN_STATE_EVENT_STREAM,
  registeredRunStateFor,
  runQueueStreamStateFor,
  runStateForTransitionKind,
  runStateStreamArmFor,
} from "./session-event-streams.js";

/** One registered payload a narrowed run stream delivers. */
export type RunStreamDelivery = RunStateChangeEvent | RunRolledBackEvent | QueueItemSummary;

/**
 * What one beat projects to on one narrowed stream.
 *
 * A returned outcome rather than a thrown error, per `core/refusal.ts`: returning a
 * refusal is the console's default and an exception is the exception. The bridge is
 * what turns `unprojectable` into the named rejection a caller sees, because the
 * refusal VOCABULARY belongs to the bridge boundary and the projection rule belongs
 * here — the same split the scenario engine and the bridge already keep for a
 * scripted reply that never came due.
 */
export type RunStreamProjection =
  | { readonly status: "projected"; readonly delivery: RunStreamDelivery }
  | { readonly status: "unprojectable"; readonly detail: string };

/**
 * The optional members of `RunStateChangeEvent` this projection carries through.
 *
 * A `Record` keyed by the derived member union rather than a hand-written list, so
 * the set is TOTAL by construction: a member added to the registered shape fails to
 * compile here, and a member this table invents fails too. Values are carried
 * wire-verbatim — the console does not re-parse a wire value, and a fixture that
 * re-validated each optional would be minting a second reading of shapes the
 * contract already owns.
 *
 * They are carried rather than dropped because a scenario that scripts one means
 * it: `completionKind` is what tells a turn-complete from a task-complete, and
 * `trigger` is what tells a budget-exhausted interrupt from a participant cancel.
 * A projection that kept only the required five would silently flatten both.
 */
const RUN_STATE_CHANGE_CARRIED_OPTIONAL_MEMBERS: Readonly<
  Record<
    Exclude<
      keyof RunStateChangeEvent,
      "runId" | "runVersion" | "previousState" | "currentState" | "timestamp"
    >,
    true
  >
> = {
  failureCategory: true,
  recoveryCondition: true,
  recoverySpanClassification: true,
  healthSignal: true,
  providerFailureDetail: true,
  completionKind: true,
  intendedClose: true,
  executionPosture: true,
  trigger: true,
  parentRunId: true,
  internalHelper: true,
  producingNodeId: true,
  admittedUnpricedCapCents: true,
  admittedModelFamily: true,
};

/**
 * The registered payload this beat travels as on this stream, or `undefined` when
 * the subscription is not one of the two narrowed run streams.
 *
 * `undefined` is deliberately not an error arm: `session.subscribe` carries the
 * whole log and a bare event-type name carries only itself, and neither registers a
 * projection for the fixture to build. Their subscribers get the envelope, which is
 * what those registrations describe.
 */
export function projectRunStreamDelivery(
  subscriptionName: string,
  event: ConsoleSessionEvent,
): RunStreamProjection | undefined {
  if (subscriptionName === RUN_STATE_EVENT_STREAM) {
    return projectRunStateStreamBeat(event);
  }
  if (subscriptionName === RUN_QUEUE_EVENT_STREAM) {
    return projectRunQueueStreamBeat(event);
  }
  return undefined;
}

/** The `run.subscribeState` arms: a state transition, or the forward rollback row. */
function projectRunStateStreamBeat(event: ConsoleSessionEvent): RunStreamProjection {
  // The arm comes from the routing table rather than from a second reading of the
  // kind here. That table is what decided this beat reaches this stream at all, so
  // asking it again is the one answer that cannot disagree with the routing.
  const arm = runStateStreamArmFor(event.kind);
  if (arm === undefined) {
    return unprojectable(
      `"${event.kind}" is not a kind the run-state stream carries, so it has no registered arm to project into.`,
    );
  }
  return arm === "rollback" ? projectRollback(event) : projectStateChange(event);
}

/** `RunStateChangeEvent` — the nine canonical transitions. */
function projectStateChange(event: ConsoleSessionEvent): RunStreamProjection {
  const payload = event.payload;
  if (payload === undefined) {
    return unprojectableFor(event, "carries no payload at all");
  }
  const runId = readWireString(payload, "runId");
  if (runId === undefined) {
    return unprojectableFor(event, "names no `runId`");
  }
  const runVersion = readWireCounter(payload, "runVersion");
  if (runVersion === undefined) {
    return unprojectableFor(
      event,
      "names no `runVersion`, the progression counter every guarded request compares against",
    );
  }
  const previousState = readRegisteredRunState(payload, "previousState");
  if (previousState === undefined) {
    return unprojectableFor(
      event,
      "names no registered `previousState`, which `RunStateChangeEvent` requires — the registered vocabulary has no pre-birth member, so a state the run came from cannot be composed here",
    );
  }
  const currentState = readRegisteredRunState(payload, "newState");
  if (currentState === undefined) {
    return unprojectableFor(event, "names no registered `newState` to project into `currentState`");
  }
  const announcedState = runStateForTransitionKind(event.kind);
  if (announcedState !== currentState) {
    return unprojectableFor(
      event,
      `announces "${String(announcedState)}" by its kind and "${currentState}" in its payload; one beat cannot report two current states`,
    );
  }
  return {
    status: "projected",
    // The carried optionals are spread FIRST so the five required members are
    // assigned after them: that ordering is what keeps this literal checked
    // against the registered shape rather than widened by a partial spread.
    delivery: {
      ...(carriedOptionalMembers(payload, RUN_STATE_CHANGE_CARRIED_OPTIONAL_MEMBERS) as Partial<
        Omit<
          RunStateChangeEvent,
          "runId" | "runVersion" | "previousState" | "currentState" | "timestamp"
        >
      >),
      // The one cast class in this module: an identifier is wire-verbatim on both
      // sides of the seam, and the registered shape spells it at a brand the
      // console has no validator for. Casting the READ value keeps the cast on one
      // token instead of on the whole literal, where it would stop the compiler
      // proving that every required member is present.
      runId: runId as RunId,
      runVersion,
      previousState,
      currentState,
      timestamp: event.occurredAt,
    },
  };
}

/** `RunRolledBackEvent` — the forward, non-state arm of the same stream. */
function projectRollback(event: ConsoleSessionEvent): RunStreamProjection {
  const payload = event.payload;
  if (payload === undefined) {
    return unprojectableFor(event, "carries no payload at all");
  }
  const runId = readWireString(payload, "runId");
  if (runId === undefined) {
    return unprojectableFor(event, "names no `runId`");
  }
  const runVersion = readWireCounter(payload, "runVersion");
  if (runVersion === undefined) {
    return unprojectableFor(event, "names no post-rollback `runVersion`");
  }
  const targetPosition = readWireCounter(payload, "targetPosition");
  if (targetPosition === undefined) {
    return unprojectableFor(
      event,
      "names no `targetPosition`, the boundary the run came to rest at",
    );
  }
  const channelId = readWireString(payload, "channelId");
  return {
    status: "projected",
    delivery: {
      // The ENVELOPE's session, not the payload's. Outer attribution and payload
      // cannot disagree by the registration's own rule, and the envelope member is
      // the one a beat always carries.
      sessionId: event.sessionId as SessionId,
      runId: runId as RunId,
      runVersion,
      ...(channelId === undefined ? {} : { channelId: channelId as ChannelId }),
      targetPosition,
    },
  };
}

/** `QueueItemSummary` — what `run.subscribeQueue` streams for one queue row. */
function projectRunQueueStreamBeat(event: ConsoleSessionEvent): RunStreamProjection {
  const announcedState = runQueueStreamStateFor(event.kind);
  if (announcedState === undefined) {
    return unprojectable(
      `"${event.kind}" is not a queue row the queue stream carries, so it announces no queue state.`,
    );
  }
  const payload = event.payload;
  if (payload === undefined) {
    return unprojectableFor(event, "carries no payload at all");
  }
  const queueItemId = readWireString(payload, "queueItemId");
  if (queueItemId === undefined) {
    return unprojectableFor(event, "names no `queueItemId`");
  }
  const statedState = readWireString(payload, "state");
  if (statedState !== undefined && statedState !== announcedState) {
    return unprojectableFor(
      event,
      `announces "${announcedState}" by its kind and "${statedState}" in its payload; one beat cannot report two queue states`,
    );
  }
  // The two members the registered summary carries and the registered EVENT payload
  // does not: the daemon projects this shape from the queue row, and the fixture's
  // only channel to a row is the beat. So a scenario has to script them, and a beat
  // that does not is refused rather than answered with a made-up priority.
  const priority = readWireCounter(payload, "priority");
  if (priority === undefined) {
    return unprojectableFor(
      event,
      "names no `priority` — `QueueItemSummary` carries queue-ROW state the event payload does not, so the beat has to script it",
    );
  }
  const createdAt =
    readWireString(payload, "createdAt") ?? createdAtForBirthRow(event, announcedState);
  if (createdAt === undefined) {
    return unprojectableFor(
      event,
      "names no `createdAt`, and only the creation row can take the beat's own `occurredAt` for it",
    );
  }
  const channelId = readWireString(payload, "channelId");
  return {
    status: "projected",
    delivery: {
      id: queueItemId as QueueItemId,
      state: announcedState,
      priority,
      ...(channelId === undefined ? {} : { channelId: channelId as ChannelId }),
      createdAt,
      // This beat IS the row's newest change, so the moment it occurred is the
      // moment the row was last updated. Sourced, not stamped from a clock.
      updatedAt: event.occurredAt,
    },
  };
}

/** The creation row's own instant, which is the row's birth. `undefined` elsewhere. */
function createdAtForBirthRow(
  event: ConsoleSessionEvent,
  announcedState: QueueItemState,
): string | undefined {
  return announcedState === "queued" ? event.occurredAt : undefined;
}

/** Every carried optional member the payload actually supplies, wire-verbatim. */
function carriedOptionalMembers(
  payload: Readonly<Record<string, unknown>>,
  carriedMembers: Readonly<Record<string, true>>,
): Readonly<Record<string, unknown>> {
  const carried: Record<string, unknown> = {};
  for (const member of Object.keys(carriedMembers)) {
    const value = payload[member];
    if (value !== undefined) {
      carried[member] = value;
    }
  }
  return carried;
}

/** One payload member as a non-empty string, or `undefined` when it is not one. */
function readWireString(
  payload: Readonly<Record<string, unknown>>,
  member: string,
): string | undefined {
  const value = payload[member];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * One payload member as a run counter: a non-negative integer.
 *
 * The registered shapes type `runVersion`, `targetPosition`, and `priority` as
 * integers, and a fractional or negative one admitted here would reach a consumer
 * at a type that says it cannot be either.
 */
function readWireCounter(
  payload: Readonly<Record<string, unknown>>,
  member: string,
): number | undefined {
  const value = payload[member];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** One payload member as a registered run state, or `undefined` when it is not one. */
function readRegisteredRunState(
  payload: Readonly<Record<string, unknown>>,
  member: string,
): RunState | undefined {
  const value = readWireString(payload, member);
  return value === undefined ? undefined : registeredRunStateFor(value);
}

/** A refusal naming the beat it is about, so a scenario author can find it. */
function unprojectableFor(event: ConsoleSessionEvent, fault: string): RunStreamProjection {
  return unprojectable(
    `the "${event.kind}" beat at sequence ${String(event.sequence)} ${fault}. ` +
      "Script the members the registered projection names, rather than letting the stream deliver a partial shape.",
  );
}

/** The refusal arm, spelled once. */
function unprojectable(detail: string): RunStreamProjection {
  return { status: "unprojectable", detail };
}
