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
// THE REGISTERED SCHEMA IS THE VALIDATOR, AND IT RUNS BEFORE DELIVERY. Every
// candidate this module composes is parsed through the shape the corpus registers
// for it, and a parse failure is a refusal carrying the failing member's own path.
// This module used to hand-check the required members and then CAST the result,
// which left the optionals unchecked entirely: a scenario scripting
// `intendedClose: false`, `healthSignal: "healthy"`, or a malformed
// `executionPosture` had them copied through wire-verbatim and presented to a
// subscriber as a valid `RunStateChangeEvent`. Nothing caught it — the scenario
// wire-truth predicate cannot, because the run-lifecycle kinds are census-only in
// `SessionEventSchema` and register no payload variant to check against — so the
// fixture delivered values the registered shape rejects, which is the one thing a
// fixture must never do. Parsing also retires every branded-identifier cast in this
// file: the schema returns the branded type, so the values are checked rather than
// asserted.
//
// WHY A VALUE IMPORT OF THE SCHEMAS IS AFFORDABLE HERE. The renderer's initial-bundle
// budget is enforced, and this module's sibling `session-event-streams.ts` keeps its
// contracts import type-only for exactly that reason — it is on the release path,
// reached from the binder one family up. This module is not: its only importer is
// `fixture-bridge.ts`, which `BridgeProvider.tsx` reaches solely inside the
// `__SIDEKICKS_CONSOLE_FIXTURES__` branch, and that identifier is a build-time
// literal, so a release bundle folds the branch away and drops this module with the
// rest of the fixture subtree. The budget therefore pays nothing for the schemas,
// and a fixture that validates what it delivers is worth strictly more than one that
// asserts it.
//
// WHAT THE SIBLING HOLDS. `run-stream-shapes.ts` carries the outcome type these arms
// return and the three things all of them do identically — the session cross-check,
// the registered-shape parse, and the refusal constructors. This file is the arms and
// the table they read; that one is what an arm is made of. The fourth, reading a wire
// member as a string, is `core/wire-strings.ts`, which is one rule wider than this
// family and had four spellings across the tree before it had a home.

import {
  QueueItemSummarySchema,
  RunRolledBackEventSchema,
  RunStateChangeEventSchema,
} from "@ai-sidekicks/contracts";
import type { RunStateChangeEvent } from "@ai-sidekicks/contracts";

import { readWireString } from "../core/index.js";
import type { ConsoleSessionEvent } from "../store/index.js";
import { RUN_QUEUE_ROW_READ, scriptedQueueRowFor } from "./queue-row-source.js";
import {
  carriedOptionalMembers,
  projectThroughRegisteredShape,
  refuseSessionDisagreement,
  unprojectable,
  unprojectableFor,
} from "./run-stream-shapes.js";
import type { RunStreamProjection } from "./run-stream-shapes.js";
import {
  RUN_QUEUE_EVENT_STREAM,
  RUN_STATE_EVENT_STREAM,
  runQueueStreamStateFor,
  runStateForTransitionKind,
  runStateStreamArmFor,
} from "./session-event-streams.js";

/**
 * The optional members of `RunStateChangeEvent` this projection carries through.
 *
 * A `Record` keyed by the derived member union rather than a hand-written list, so
 * the set is TOTAL by construction: a member added to the registered shape fails to
 * compile here, and a member this table invents fails too. Values are carried
 * wire-verbatim as far as the parse, which is what then decides whether the shape
 * admits them — this table says which members travel, never whether a value is one
 * the contract accepts.
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
 *
 * `scriptedQueueRowRead` is the result of the scenario's `run.queueList` reply, the
 * queue arm's second source. Absent for every other subscription, and absent for a
 * scenario that scripts no such reply — which is a refusal on the queue arm rather
 * than a made-up row.
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

/** `RunStateChangeEvent` — the canonical transitions. */
function projectStateChange(event: ConsoleSessionEvent): RunStreamProjection {
  const payload = event.payload;
  if (payload === undefined) {
    return unprojectableFor(event, "carries no payload at all");
  }
  const sessionDisagreement = refuseSessionDisagreement(event, payload);
  if (sessionDisagreement !== undefined) {
    return sessionDisagreement;
  }
  // The one cross-check no schema can make: the kind and the payload each name the
  // state the run is now in, and they have to be the same state. Checked before the
  // parse because it is a fact about this BEAT rather than about the shape — a
  // `run.running` frame reporting `paused` routes by one key and renders by the
  // other, and both values pass the registered vocabulary.
  const announcedState = runStateForTransitionKind(event.kind);
  const statedState = payload["newState"];
  if (statedState === undefined) {
    return unprojectableFor(
      event,
      "names no `newState` to project into the registered `currentState`",
    );
  }
  if (statedState !== announcedState) {
    return unprojectableFor(
      event,
      `announces "${String(announcedState)}" by its kind and ${JSON.stringify(statedState)} in its payload; one beat cannot report two current states`,
    );
  }
  return projectThroughRegisteredShape(RunStateChangeEventSchema, event, {
    // The carried optionals are spread FIRST so a payload that also spells one of
    // the five required members under an optional's name cannot displace it.
    ...carriedOptionalMembers(payload, RUN_STATE_CHANGE_CARRIED_OPTIONAL_MEMBERS),
    runId: payload["runId"],
    runVersion: payload["runVersion"],
    previousState: payload["previousState"],
    // The one rename in this module: the durable payload spells the run's new state
    // `newState`, and the registered stream member is `currentState`.
    currentState: statedState,
    timestamp: event.occurredAt,
  });
}

/** `RunRolledBackEvent` — the forward, non-state arm of the same stream. */
function projectRollback(event: ConsoleSessionEvent): RunStreamProjection {
  const payload = event.payload;
  if (payload === undefined) {
    return unprojectableFor(event, "carries no payload at all");
  }
  const sessionDisagreement = refuseSessionDisagreement(event, payload);
  if (sessionDisagreement !== undefined) {
    return sessionDisagreement;
  }
  const channelId = readWireString(payload["channelId"]);
  return projectThroughRegisteredShape(RunRolledBackEventSchema, event, {
    // The PAYLOAD's session, checked equal to the envelope's just above and then
    // carried untouched. Copying the envelope's here instead would make that check
    // vacuous — the value delivered would agree with the envelope by construction
    // rather than because the beat said so.
    sessionId: payload["sessionId"],
    runId: payload["runId"],
    runVersion: payload["runVersion"],
    ...(channelId === undefined ? {} : { channelId }),
    targetPosition: payload["targetPosition"],
  });
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
  const sessionDisagreement = refuseSessionDisagreement(event, payload);
  if (sessionDisagreement !== undefined) {
    return sessionDisagreement;
  }
  const queueItemId = readWireString(payload["queueItemId"]);
  if (queueItemId === undefined) {
    return unprojectableFor(event, "names no `queueItemId` to find its queue row by");
  }
  // Required, exactly as `newState` is on the state arm above. `Spec-006 §Queue
  // Events` fixes the payload at `{sessionId, queueItemId, channelId?, state}`, so
  // a beat without one is not a queue event that omitted a check — it is a queue
  // event no daemon emits. Skipping the comparison when the member was absent let
  // the summary take its state from the KIND alone and delivered a valid-looking
  // `QueueItemSummary` built from a payload the contract rejects.
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
      `announces "${announcedState}" by its kind and ${JSON.stringify(statedState)} in its payload; one beat cannot report two queue states`,
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
  const channelId = readWireString(queueRow["channelId"]);
  const announcedChannelId = readWireString(payload["channelId"]);
  if (announcedChannelId !== undefined && announcedChannelId !== channelId) {
    return unprojectableFor(
      event,
      `names channel "${announcedChannelId}" while its queue row names ${
        channelId === undefined ? "none" : `"${channelId}"`
      }; one queue item sits in one channel`,
    );
  }
  return projectThroughRegisteredShape(QueueItemSummarySchema, event, {
    id: queueItemId,
    state: announcedState,
    // Row members, carried through untouched — the daemon reads them off the row and
    // so does this. Their types are the schema's business: `priority` is
    // `z.number().int()` with no `.nonnegative()`, because the column reads "higher
    // = more urgent" and a negative priority is a deliberate de-prioritization.
    priority: queueRow["priority"],
    ...(channelId === undefined ? {} : { channelId }),
    createdAt: queueRow["createdAt"],
    // This beat IS the row's newest change, so the moment it occurred is the
    // moment the row was last updated. Sourced, not stamped from a clock.
    updatedAt: event.occurredAt,
  });
}
