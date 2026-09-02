// What a `daemon.subscribe` name delivers: the closed set of session-event STREAMS
// and the event kinds each one carries.
//
// `daemon.subscribe(name, handler)` names either a registered STREAM or a single
// event type, and the two answer differently — a stream delivers a projection of
// many kinds, an event type delivers only its own. Both sides of that seam read
// this module: `frame/session-event-binder.ts` passes a stream name to
// `daemon.subscribe`, and `fixture-bridge.ts` has to route by the same table to
// answer the way the daemon would. Two copies of the rule would let the producer
// and the consumer drift while every test still passed — which is exactly what
// happened before this table existed: the fixture recognised one stream name and
// delivered NOTHING to a subscriber that named either of the other two, so every
// run beat a scenario scripts was invisible to the surface that had asked for it,
// and the silence was indistinguishable from a quiet session.
//
// WHERE THE ROWS COME FROM. Each row is a subscription the corpus registers, and
// the kinds it carries are read off that registration rather than chosen here:
//
//   • `session.subscribe` — the replay-then-tail stream of the WHOLE session
//     (`docs/architecture/contracts/api-payload-contracts.md`, the Tier-1
//     long-lived `LocalSubscriptionConsumer<EventEnvelope>` row). Every kind the
//     session emits reaches it.
//   • `run.subscribeState` — streams `RunStateChangeEvent | RunRolledBackEvent`.
//     The first arm is one event per canonical run state, so its kinds are the
//     registered `RunState` union under the `run.` root; the second arm is the
//     forward, non-state `run.rolled_back` row that the same registration names as
//     riding the same stream.
//   • `run.subscribeQueue` — streams the `QueueItemSummary` projection, which is
//     what each `queue_item.*` row announces, so its kinds are that root within
//     the registered census.
//
// HOW THE KINDS STAY BOUND TO THE WIRE. Every kind below is a member of a record
// declared `satisfies Record<<derived kind union>, …>`, and each union is
// `Extract`ed from the contracts census (`SessionEventType`) intersected with the
// registered vocabulary the stream projects (`RunState`, the `queue_item.` root).
// Totality and excess are therefore both compile-time facts: a newly registered
// run state or queue row fails this file, and a kind this table invents fails it
// too. The import stays TYPE-ONLY — the renderer's initial-bundle budget is
// enforced, and a value import of the census would pull the whole taxonomy module
// and its schemas into the console — so the runtime cross-check against
// `SESSION_EVENT_CATEGORY_BY_TYPE` lives in the co-located test, which is not
// bundled and can therefore read the census itself.

import type { QueueItemState, RunState, SessionEventType } from "@ai-sidekicks/contracts";

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
 * The registered event kinds `run.subscribeState` projects, and the wire arm each
 * one travels as.
 *
 * The union is derived twice over — the census filtered to the `run.` root, then
 * intersected with the registered run-state vocabulary — so the nine transitions
 * are the nine canonical states and nothing else. `run.rolled_back` joins them
 * explicitly because it is the stream's SECOND registered arm rather than a
 * transition: it records no state change, which is why the registration gives it
 * its own payload shape and why deriving it from `RunState` is impossible.
 *
 * The three forward, non-state run rows the taxonomy also registers —
 * provider-initialization, turn-start, worker-shutdown — are deliberately absent:
 * neither wire arm can represent one, so a subscriber to this stream never sees
 * them, and a table that carried them would train a surface on a frame the daemon
 * does not send here.
 */
type RunStateStreamKind = Extract<SessionEventType, `run.${RunState}` | "run.rolled_back">;

/** Which of the stream's two registered arms a kind is projected into. */
type RunStateStreamArm = "state-change" | "rollback";

const RUN_STATE_STREAM_ARM_BY_KIND = {
  "run.queued": "state-change",
  "run.starting": "state-change",
  "run.running": "state-change",
  "run.waiting_for_approval": "state-change",
  "run.waiting_for_input": "state-change",
  "run.paused": "state-change",
  "run.completed": "state-change",
  "run.interrupted": "state-change",
  "run.failed": "state-change",
  "run.rolled_back": "rollback",
} as const satisfies Record<RunStateStreamKind, RunStateStreamArm>;

/**
 * The registered event kinds `run.subscribeQueue` projects, and the queue state
 * each one announces.
 *
 * The value is the registered `QueueItemState` the emitted `QueueItemSummary`
 * carries for that row, which is what binds the row to the projection rather than
 * merely to its own name — and it is why the record is a map rather than a list:
 * the queue's first row is `queue_item.created` while the state it announces is
 * `queued`, so a table that assumed the name and the state were one string would
 * be wrong about the only member where it matters.
 */
type RunQueueStreamKind = Extract<SessionEventType, `queue_item.${string}`>;

const RUN_QUEUE_STREAM_STATE_BY_KIND = {
  "queue_item.created": "queued",
  "queue_item.admitted": "admitted",
  "queue_item.superseded": "superseded",
  "queue_item.canceled": "canceled",
  "queue_item.expired": "expired",
} as const satisfies Record<RunQueueStreamKind, QueueItemState>;

/**
 * A stream that carries a session's whole event log.
 *
 * It enumerates no kinds, and the absence is the honest shape rather than a gap:
 * the set it would enumerate is the entire registered census, which this module
 * cannot hold as a runtime value without pulling the taxonomy into the renderer
 * bundle — and a routing rule that answers "yes" for every kind needs no set to
 * answer with.
 */
export interface WholeSessionEventStream {
  readonly scope: "whole-session";
}

/** A stream that carries a named projection of the session's kinds. */
export interface NarrowedSessionEventStream {
  readonly scope: "selected-kinds";
  /**
   * The routing index for this stream's kinds, built from the contract-bound
   * record that declares them. Typed as strings because a subscriber's event
   * `kind` arrives wire-verbatim: the membership test IS what recognises it, and
   * the registration proof lives on the record rather than on this lookup.
   */
  readonly carriedKinds: ReadonlySet<string>;
}

/** One registered session-event stream. */
export type ConsoleSessionEventStream = WholeSessionEventStream | NarrowedSessionEventStream;

/**
 * One registered stream name — the three declarations above, read as a type.
 *
 * `typeof` each constant rather than the strings written a second time: a union
 * spelling them again would be a set that agrees with the constants only by
 * discipline, and this file exists because two spellings of one subscribe seam
 * had already drifted once.
 */
export type ConsoleSessionEventStreamName =
  | typeof SESSION_EVENT_STREAM
  | typeof RUN_STATE_EVENT_STREAM
  | typeof RUN_QUEUE_EVENT_STREAM;

/**
 * Every session-event stream the console can subscribe to. Closed, and the one
 * authority on which kinds each carries.
 *
 * Keyed by subscription name rather than listed, so the table is total over the
 * names by construction: a registered stream with no row here, or a row for a
 * name nothing registers, is a compile error rather than a silent hole in the
 * routing — which is precisely the shape the defect this table replaces took.
 */
export const CONSOLE_SESSION_EVENT_STREAMS: Readonly<
  Record<ConsoleSessionEventStreamName, ConsoleSessionEventStream>
> = {
  [SESSION_EVENT_STREAM]: { scope: "whole-session" },
  [RUN_STATE_EVENT_STREAM]: {
    scope: "selected-kinds",
    carriedKinds: new Set(Object.keys(RUN_STATE_STREAM_ARM_BY_KIND)),
  },
  [RUN_QUEUE_EVENT_STREAM]: {
    scope: "selected-kinds",
    carriedKinds: new Set(Object.keys(RUN_QUEUE_STREAM_STATE_BY_KIND)),
  },
};

/** The registered stream this subscription name is, or `undefined` if it is not one. */
export function sessionEventStreamFor(
  subscriptionName: string,
): ConsoleSessionEventStream | undefined {
  // Read through a widened view rather than an indexed access on the keyed
  // record: the argument is a wire-verbatim string, and asking the keyed shape
  // about one would need an assertion that claims the answer this lookup exists
  // to find out.
  const streamsByName: Readonly<Record<string, ConsoleSessionEventStream | undefined>> =
    CONSOLE_SESSION_EVENT_STREAMS;
  return streamsByName[subscriptionName];
}

/**
 * Does a subscriber that named `subscriptionName` receive an event of this kind?
 *
 * The two arms of `daemon.subscribe` in one predicate, because they are one
 * decision: a registered stream delivers what its row carries, and every other
 * name is an event type that delivers only itself. A name that is neither — a
 * stream the corpus does not register, or a typo — matches no kind and therefore
 * receives nothing, which is what the daemon does with a subscription it cannot
 * serve and what keeps an unnoticed misspelling from quietly reading as an empty
 * session.
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
  return stream.carriedKinds.has(eventKind);
}
