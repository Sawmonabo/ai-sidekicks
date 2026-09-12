// What a `daemon.subscribe` name delivers: the closed set of registered STREAMS and
// the routing every subscription in the renderer goes through.
//
// `daemon.subscribe(name, handler)` names either a registered STREAM or a single
// event type, and the two answer differently — a stream delivers a projection of
// many kinds, an event type delivers only its own. Both sides of that seam read this
// module: `frame/session/session-event-binder.ts` passes a stream name to `daemon.subscribe`,
// and `fixture/call-plane/subscriptions.ts` has to route by the same table to answer the
// way the daemon would. Two copies of the rule would let the producer and the
// consumer drift while every test still passed — which is exactly what happened
// before this table existed: the fixture recognised one stream name and delivered
// NOTHING to a subscriber that named either of the other two, so every run beat a
// scenario scripts was invisible to the surface that had asked for it, and the
// silence was indistinguishable from a quiet session.
//
// WHICH KINDS A NARROWED STREAM CARRIES IS `session-event-stream-kinds.ts`, one
// module down. The rows below are composed out of that module's lists rather than
// restating them, and the reason the two are separate files is that they answer
// different questions with different readers: this one is asked by everything that
// opens or serves a subscription, and that one is asked by everything that has to
// know what a carried kind announces about the run or the queue row underneath it.
//
// WHERE THE ROWS COME FROM. Each row is a subscription the corpus registers:
//
//   • `session.subscribe` — the replay-then-tail stream of the WHOLE session
//     (`docs/architecture/contracts/api-payload-contracts.md`, the Tier-1
//     long-lived `LocalSubscriptionConsumer<EventEnvelope>` row). Every kind the
//     session emits reaches it.
//   • `run.subscribeState` — streams `RunStateChangeEvent | RunRolledBackEvent`.
//   • `run.subscribeQueue` — streams the `QueueItemSummary` projection.
//   • `presence.subscribe` — the session's Awareness room, which is the one row here
//     that is not a session-event stream and is registered anyway: it IS a
//     `daemon.subscribe` name, and a table that held every OTHER name left this one
//     falling through to the bare-event-type arm, where it matched the kind
//     `presence.subscribe` that no census registers and therefore delivered nothing
//     at all.
//
// FROZEN AT EVERY LEVEL — the table and each row on it — because it is exported: a
// reachable mutation would re-route every subscription in the renderer at once, and
// the readonly types alone say nothing about that at runtime. That is not a style
// choice but the defect this table replaces: the rows used to be `ReadonlySet` views
// over mutable `Set`s, which is a TypeScript view and nothing more, so one
// `carriedKinds.add(…)` anywhere in the process would have re-routed every fixture
// subscription in that renderer for the rest of its life with no compiler and no test
// saying so. The kind lists carry their own freeze next door, where they are
// declared.

import type { RunState } from "@ai-sidekicks/contracts";

import {
  PRESENCE_STREAM_CARRIED_KINDS,
  RUN_QUEUE_STREAM_CARRIED_KINDS,
  RUN_STATE_STREAM_CARRIED_KINDS,
  readFrozenRecord,
  runStateStreamArmFor,
} from "./session-event-stream-kinds.js";

/**
 * The registered subscription name for a session's whole event stream.
 *
 * Named verbatim rather than invented: a console that subscribed to a string the
 * daemon does not serve would get silence indistinguishable from a quiet session.
 */
export const SESSION_EVENT_STREAM = "session.subscribe";

/** The registered subscription name for a run's state-transition stream. */
export const RUN_STATE_EVENT_STREAM = "run.subscribeState";

/** The registered subscription name for a session's queue-projection stream. */
export const RUN_QUEUE_EVENT_STREAM = "run.subscribeQueue";

/**
 * The registered subscription name for a session's Awareness room.
 *
 * Declared here for the reason the three above are: this module is the one place that
 * says what a `daemon.subscribe` name delivers, and a second spelling of a subscribe
 * name is the drift it exists to end. Two console surfaces answer this push with two
 * different reads — who is present, and what they are doing — and neither opens its
 * payload.
 */
export const PRESENCE_EVENT_STREAM = "presence.subscribe";

/** The namespace prefix every run-lifecycle event kind carries. */
const RUN_EVENT_KIND_PREFIX = "run.";

/**
 * A stream that carries a session's whole event log.
 *
 * It enumerates no kinds, and the absence is the honest shape rather than a gap:
 * the set it would enumerate is the entire registered census, which no module on the
 * release path can hold as a runtime value without pulling the taxonomy into the
 * renderer bundle — and a routing rule that answers "yes" for every kind needs no
 * set to answer with.
 */
export interface WholeSessionEventStream {
  readonly scope: "whole-session";
}

/** A stream that carries a named projection of the session's kinds. */
export interface NarrowedSessionEventStream {
  readonly scope: "selected-kinds";
  /**
   * This stream's kinds, taken from the contract-bound record next door that
   * declares them and frozen there. Typed as strings because a subscriber's event
   * `kind` arrives wire-verbatim: the membership test IS what recognises it, and the
   * registration proof lives on that record rather than on this list.
   */
  readonly carriedKinds: readonly string[];
}

/**
 * A stream whose deliveries are CHANGE SIGNALS rather than frames.
 *
 * It carries kinds like a narrowed stream and delivers none of them: what reaches a
 * subscriber is that the room moved, and the reading comes from the room's own read.
 * A separate scope rather than a narrowed stream with a flag, because the two answer a
 * subscriber differently at the delivery seam — `fixture/call-plane/subscriptions.ts` routes on
 * exactly this discriminant — and a flag on the narrowed row would have to be read by
 * everything that handles one.
 *
 * Its kinds are not the whole of when it fires. A room moves when a device's presence
 * transitions, which is a kind here, and when a run's activity changes, which the
 * census carries no event for at all: the activity field rides beside presence rather
 * than inside it. So the kinds are the log-borne half, and whatever serves this
 * subscription owns the other.
 */
export interface AwarenessSignalStream {
  readonly scope: "awareness-signal";
  /** The log-borne half of when the room moves. Frozen, for `carriedKinds`' reason. */
  readonly carriedKinds: readonly string[];
}

/** One registered subscription this console opens. */
export type ConsoleSessionEventStream =
  | WholeSessionEventStream
  | NarrowedSessionEventStream
  | AwarenessSignalStream;

/**
 * One registered stream name — the four declarations above, read as a type.
 *
 * `typeof` each constant rather than the strings written a second time: a union
 * spelling them again would be a set that agrees with the constants only by
 * discipline, and this file exists because two spellings of one subscribe seam
 * had already drifted once.
 */
export type ConsoleSessionEventStreamName =
  | typeof SESSION_EVENT_STREAM
  | typeof RUN_STATE_EVENT_STREAM
  | typeof RUN_QUEUE_EVENT_STREAM
  | typeof PRESENCE_EVENT_STREAM;

/**
 * Every session-event stream the console can subscribe to. Closed, frozen, and the
 * one authority on which name routes where.
 *
 * Keyed by subscription name rather than listed, so the table is total over the
 * names by construction: a registered stream with no row here, or a row for a
 * name nothing registers, is a compile error rather than a silent hole in the
 * routing — which is precisely the shape the defect this table replaces took.
 */
export const CONSOLE_SESSION_EVENT_STREAMS: Readonly<
  Record<ConsoleSessionEventStreamName, ConsoleSessionEventStream>
> = Object.freeze({
  [SESSION_EVENT_STREAM]: Object.freeze({
    scope: "whole-session",
  } satisfies ConsoleSessionEventStream),
  [RUN_STATE_EVENT_STREAM]: Object.freeze({
    scope: "selected-kinds",
    carriedKinds: RUN_STATE_STREAM_CARRIED_KINDS,
  } satisfies ConsoleSessionEventStream),
  [RUN_QUEUE_EVENT_STREAM]: Object.freeze({
    scope: "selected-kinds",
    carriedKinds: RUN_QUEUE_STREAM_CARRIED_KINDS,
  } satisfies ConsoleSessionEventStream),
  [PRESENCE_EVENT_STREAM]: Object.freeze({
    scope: "awareness-signal",
    carriedKinds: PRESENCE_STREAM_CARRIED_KINDS,
  } satisfies ConsoleSessionEventStream),
});

/** The registered stream this subscription name is, or `undefined` if it is not one. */
export function sessionEventStreamFor(
  subscriptionName: string,
): ConsoleSessionEventStream | undefined {
  return readFrozenRecord(CONSOLE_SESSION_EVENT_STREAMS, subscriptionName);
}

/**
 * Does a subscriber that named `subscriptionName` hear about an event of this kind?
 *
 * The two arms of `daemon.subscribe` in one predicate, because they are one
 * decision: a registered stream delivers what its row carries, and every other
 * name is an event type that delivers only itself. A name that is neither — a
 * stream the corpus does not register, or a typo — matches no kind and therefore
 * receives nothing, which is what the daemon does with a subscription it cannot
 * serve and what keeps an unnoticed misspelling from quietly reading as an empty
 * session.
 *
 * HEARS ABOUT rather than RECEIVES, for the awareness row alone: its subscriber is
 * handed a payload-free signal when one of its kinds lands, never the frame. What is
 * delivered is the serving seam's answer; this one is about which kinds bear on the
 * subscription at all.
 */
export function subscriptionDeliversEventKind(
  subscriptionName: string,
  eventKind: string,
): boolean {
  const stream = sessionEventStreamFor(subscriptionName);
  if (stream === undefined) {
    return eventKind === subscriptionName;
  }
  if (stream.scope === "whole-session") {
    return true;
  }
  return stream.carriedKinds.includes(eventKind);
}

/**
 * The run state a state-change kind announces, or `undefined` for any other kind.
 *
 * The one per-kind reading on this side of the seam, and it is here because its
 * readers are the two surfaces that consume a DELIVERED frame — the frame's
 * run-lifecycle projector and the run-stream projection — rather than anything that
 * asks what a stream carries. It reads the arm table next door instead of a second
 * table of its own.
 *
 * Read off the kind rather than out of a table at all: `run.waiting_for_approval`
 * announces `waiting_for_approval`, because the kind IS the prefix plus the state,
 * which is why the arm union could be `Extract`ed with a template literal in the
 * first place. Sound by that record's own key type — every `state-change` row is
 * keyed `run.${RunState}`, and the one key that is not is the `rollback` row this
 * guard excludes.
 */
export function runStateForTransitionKind(eventKind: string): RunState | undefined {
  return runStateStreamArmFor(eventKind) === "state-change"
    ? (eventKind.slice(RUN_EVENT_KIND_PREFIX.length) as RunState)
    : undefined;
}
