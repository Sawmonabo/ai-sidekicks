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
// WHERE THE MEMBERS COME FROM. Each one is sourced and nothing is composed:
// `newState` becomes `currentState`, the envelope's `occurredAt` becomes the
// state-change `timestamp` and the queue row's `updatedAt`, and the beat's own KIND
// supplies the queue state through the same table that routed it here. A beat that
// cannot supply a required member is REFUSED — loudly, by name, through the
// fixture's own refusal vocabulary — rather than delivered half-built, because a
// projection missing a required member is exactly the shape a surface renders as
// blank and a reviewer reads as working.
//
// THE QUEUE STREAM HAS A SECOND SOURCE, AND HAS TO. `QueueItemSummary` is a
// projection of the `queue_items` ROW, so it requires `priority` and `createdAt`,
// which the registered queue payload does not carry — `Spec-006 §Queue Events` fixes
// it at `{sessionId, queueItemId, channelId?, state}`. This module used to demand
// those two off the beat, which refused every contract-valid queue event and made
// the only way to pass a beat carrying members no daemon emits. The row now arrives
// from the scenario's own `run.queueList` reply, which is the read the daemon
// projects the summary from; `queue-row-source.ts` owns that seam.
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
  QueueItemSummary,
  RunId,
  RunRolledBackEvent,
  RunState,
  RunStateChangeEvent,
  SessionId,
} from "@ai-sidekicks/contracts";

import type { ConsoleSessionEvent } from "../store/index.js";
import { RUN_QUEUE_ROW_READ, scriptedQueueRowFor } from "./queue-row-source.js";
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
  scriptedQueueRowRead?: unknown,
): RunStreamProjection | undefined {
  if (subscriptionName === RUN_STATE_EVENT_STREAM) {
    return projectRunStateStreamBeat(event);
  }
  if (subscriptionName === RUN_QUEUE_EVENT_STREAM) {
    return projectRunQueueStreamBeat(event, scriptedQueueRowRead);
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
function projectRunQueueStreamBeat(
  event: ConsoleSessionEvent,
  scriptedQueueRowRead: unknown,
): RunStreamProjection {
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
  // The row, not the beat. `QueueItemSummary` is a projection of `queue_items` and
  // carries members the registered queue payload does not; `queue-row-source.ts`
  // carries the whole reasoning, and the short version is that a beat asked for
  // `priority` is a beat asked for something no daemon puts on one.
  const queueRow = scriptedQueueRowFor(scriptedQueueRowRead, queueItemId);
  if (queueRow === undefined) {
    return unprojectableFor(
      event,
      `is about queue item "${queueItemId}", for which the scenario's \`${RUN_QUEUE_ROW_READ}\` reply carries no row — and the row is where \`priority\` and \`createdAt\` live`,
    );
  }
  const priority = readWireInteger(queueRow, "priority");
  if (priority === undefined) {
    return unprojectableFor(event, "reads a queue row that names no whole-number `priority`");
  }
  const createdAt = readWireString(queueRow, "createdAt");
  if (createdAt === undefined) {
    return unprojectableFor(event, "reads a queue row that names no `createdAt`");
  }
  const channelId = readWireString(queueRow, "channelId");
  const announcedChannelId = readWireString(payload, "channelId");
  if (announcedChannelId !== undefined && announcedChannelId !== channelId) {
    return unprojectableFor(
      event,
      `names channel "${announcedChannelId}" while its queue row names ${
        channelId === undefined ? "none" : `"${channelId}"`
      }; one queue item sits in one channel`,
    );
  }
  return {
    status: "projected",
    delivery: {
      id: queueItemId as QueueItemId,
      state: announcedState,
      // Row members, carried through untouched — the daemon reads them off the row
      // and so does this.
      priority,
      ...(channelId === undefined ? {} : { channelId: channelId as ChannelId }),
      createdAt,
      // This beat IS the row's newest change, so the moment it occurred is the
      // moment the row was last updated. Sourced, not stamped from a clock.
      updatedAt: event.occurredAt,
    },
  };
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
 * One member as a run counter: a non-negative integer.
 *
 * The registered shapes type `runVersion` and `targetPosition` as non-negative
 * integers, and a fractional or negative one admitted here would reach a consumer
 * at a type that says it cannot be either.
 */
function readWireCounter(
  payload: Readonly<Record<string, unknown>>,
  member: string,
): number | undefined {
  const value = readWireInteger(payload, member);
  return value !== undefined && value >= 0 ? value : undefined;
}

/**
 * One member as a whole number of either sign.
 *
 * `priority` is the member that needs this and not the counter above: the column's
 * own comment reads "higher = more urgent" and `QueueItemSummarySchema` types it
 * `z.number().int()` without `.nonnegative()`, so a negative priority is a
 * deliberate de-prioritization rather than a malformed value. Refusing one here
 * would have made a legitimate row unprojectable.
 */
function readWireInteger(
  payload: Readonly<Record<string, unknown>>,
  member: string,
): number | undefined {
  const value = payload[member];
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
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
      "Script what the registered projection reads — the beat's own registered payload, and the " +
      "row read it projects from — rather than letting the stream deliver a partial shape.",
  );
}

/** The refusal arm, spelled once. */
function unprojectable(detail: string): RunStreamProjection {
  return { status: "unprojectable", detail };
}
