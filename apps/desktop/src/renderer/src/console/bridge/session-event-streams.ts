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
//     The first arm is one event per canonical run state the machine can transition
//     INTO, so its kinds are the registered `RunState` union under the `run.` root
//     less the initial state; the second arm is the forward, non-state
//     `run.rolled_back` row that the same registration names as riding the same
//     stream.
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
// enforced and this module is on the RELEASE path, reached from the binder one
// family up, so a value import of the census would pull the whole taxonomy module
// and its schemas into the shipped console — and the runtime cross-check against
// `SESSION_EVENT_CATEGORY_BY_TYPE` therefore lives in the co-located test, which
// is not bundled and can read the census itself.
//
// WHY EVERY COLLECTION HERE IS A FROZEN RECORD OR A FROZEN ARRAY, AND NOT A `Set`
// OR A `Map`. This table is a compile-time constant that every subscription in a
// renderer routes through, and it used to be exported as `ReadonlySet` views over
// mutable `Set`s with a module-level `Map` and `Set` beside them. `ReadonlySet` is
// a TypeScript view and nothing more: `CONSOLE_SESSION_EVENT_STREAMS` is exported,
// so one `carriedKinds.add(…)` anywhere in the process would have re-routed EVERY
// fixture subscription in that renderer for the rest of its life, and no compiler
// and no test would have said so. Module-level mutable singletons are rejected
// outright by `apps/desktop/AGENTS.md §State and views` for exactly that reason.
//
// The replacement is immutable record membership rather than an encapsulated class
// with private fields, and the choice is not stylistic. A class exists to own
// STATE, and there is none here to own: which kinds `run.subscribeState` carries is
// a fact about the wire contract, identical in every renderer and for every bridge
// instance, so a per-instance registry would hand each bridge its own copy of one
// constant and invite the two copies to answer differently. What was actually
// wrong was reachable mutability, and `Object.freeze` removes it at the root:
// membership is a pure lookup over frozen data, there is nothing to construct,
// nothing to inject, and nothing for one subscription to change out from under
// another.

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

/** The namespace prefix every run-lifecycle event kind carries. */
const RUN_EVENT_KIND_PREFIX = "run.";

/**
 * The run's initial state.
 *
 * `docs/domain/run-state-machine.md` calls `queued` the state a run is CREATED in,
 * and its §Complete Transition Table — the single authoritative reference — names
 * `queued` in the `From` column of three rows and in the `To` column of none. So no
 * transition ends in `queued`, and `RunStateChangeEvent` requires a `previousState`:
 * there is no registered state a run could have come from to reach it, and no
 * pre-birth member of the vocabulary to invent one out of.
 */
type RunInitialState = "queued";

/**
 * The registered event kinds `run.subscribeState` projects, and the wire arm each
 * one travels as.
 *
 * The union is derived three ways over — the census filtered to the `run.` root,
 * intersected with the registered run-state vocabulary, less the initial state — so
 * the eight transitions are exactly the states the machine can move a run INTO.
 * `run.rolled_back` joins them explicitly because it is the stream's SECOND
 * registered arm rather than a transition: it records no state change, which is why
 * the registration gives it its own payload shape and why deriving it from
 * `RunState` is impossible.
 *
 * `run.queued` is the excluded one, and it is excluded for the same reason the three
 * forward rows below are: neither wire arm can represent it. It is the run's
 * CREATION rather than a transition — a beat carrying it reaches a subscriber
 * through `session.subscribe`, where the run-lifecycle projector folds it into the
 * run's existence — and the scenario that used to script `previousState: "queued"`
 * on it to satisfy this stream was describing a self-transition the machine defines
 * for no state, which a surface could then learn to render or count.
 *
 * The three forward, non-state run rows the taxonomy also registers —
 * provider-initialization, turn-start, worker-shutdown — are deliberately absent
 * too, and a table that carried any of these four would train a surface on a frame
 * the daemon does not send here.
 *
 * EXPORTED for one reader, and for what its COMPLEMENT is: the four run-lifecycle
 * kinds this union leaves out are exactly the kinds no narrowed stream projects, and
 * `scenarios/wire-truth/run-and-queue-semantics.ts` subtracts this union from the
 * census's `run.` root to hold each of them to its own registered payload. Derived
 * there rather than listed, so a run kind that joins or leaves this stream moves
 * across that walk's obligation without anyone editing a second list.
 */
export type RunStateStreamKind = Extract<
  SessionEventType,
  `run.${Exclude<RunState, RunInitialState>}` | "run.rolled_back"
>;

/**
 * Which of the stream's two registered arms a kind is projected into.
 *
 * Exported because the arm is not a fact about ROUTING alone: the two arms are two
 * different registered wire shapes, so whatever builds one of them has to read the
 * same table that decided the kind belongs here. A second reading of "which arm is
 * this" would be the drift this module was written to end, one layer up.
 */
export type RunStateStreamArm = "state-change" | "rollback";

const RUN_STATE_STREAM_ARM_BY_KIND: Readonly<Record<RunStateStreamKind, RunStateStreamArm>> =
  Object.freeze({
    "run.starting": "state-change",
    "run.running": "state-change",
    "run.waiting_for_approval": "state-change",
    "run.waiting_for_input": "state-change",
    "run.paused": "state-change",
    "run.completed": "state-change",
    "run.interrupted": "state-change",
    "run.failed": "state-change",
    "run.rolled_back": "rollback",
  } satisfies Record<RunStateStreamKind, RunStateStreamArm>);

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

const RUN_QUEUE_STREAM_STATE_BY_KIND: Readonly<Record<RunQueueStreamKind, QueueItemState>> =
  Object.freeze({
    "queue_item.created": "queued",
    "queue_item.admitted": "admitted",
    "queue_item.superseded": "superseded",
    "queue_item.canceled": "canceled",
    "queue_item.expired": "expired",
  } satisfies Record<RunQueueStreamKind, QueueItemState>);

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
   * This stream's kinds, read off the contract-bound record that declares them and
   * frozen. Typed as strings because a subscriber's event `kind` arrives
   * wire-verbatim: the membership test IS what recognises it, and the registration
   * proof lives on the record rather than on this list.
   *
   * A frozen array rather than a `ReadonlySet`, because the readonly view was the
   * defect — nine members are a `.includes` away, and the array cannot be added to
   * by a caller that got hold of it.
   */
  readonly carriedKinds: readonly string[];
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
 * Every session-event stream the console can subscribe to. Closed, frozen, and the
 * one authority on which kinds each carries.
 *
 * Keyed by subscription name rather than listed, so the table is total over the
 * names by construction: a registered stream with no row here, or a row for a
 * name nothing registers, is a compile error rather than a silent hole in the
 * routing — which is precisely the shape the defect this table replaces took.
 *
 * Frozen at every level — the table, each row, and each row's kind list — because
 * it is exported: a reachable mutation would re-route every subscription in the
 * renderer at once, and the readonly types alone say nothing about that at runtime.
 */
export const CONSOLE_SESSION_EVENT_STREAMS: Readonly<
  Record<ConsoleSessionEventStreamName, ConsoleSessionEventStream>
> = Object.freeze({
  [SESSION_EVENT_STREAM]: Object.freeze({
    scope: "whole-session",
  } satisfies ConsoleSessionEventStream),
  [RUN_STATE_EVENT_STREAM]: Object.freeze({
    scope: "selected-kinds",
    carriedKinds: Object.freeze(Object.keys(RUN_STATE_STREAM_ARM_BY_KIND)),
  } satisfies ConsoleSessionEventStream),
  [RUN_QUEUE_EVENT_STREAM]: Object.freeze({
    scope: "selected-kinds",
    carriedKinds: Object.freeze(Object.keys(RUN_QUEUE_STREAM_STATE_BY_KIND)),
  } satisfies ConsoleSessionEventStream),
});

/**
 * Which registered arm of `run.subscribeState` this event kind travels as, or
 * `undefined` when the stream does not carry the kind at all.
 */
export function runStateStreamArmFor(eventKind: string): RunStateStreamArm | undefined {
  return readFrozenRecord(RUN_STATE_STREAM_ARM_BY_KIND, eventKind);
}

/**
 * The run state a state-change kind announces, or `undefined` for any other kind.
 *
 * Read off the kind rather than out of a second table: `run.waiting_for_approval`
 * announces `waiting_for_approval`, because the kind IS the prefix plus the state,
 * which is why the union above could be `Extract`ed with a template literal in the
 * first place. Sound by the arm record's own key type — every `state-change` row is
 * keyed `run.${RunState}`, and the one key that is not is the `rollback` row this
 * guard excludes.
 */
export function runStateForTransitionKind(eventKind: string): RunState | undefined {
  return runStateStreamArmFor(eventKind) === "state-change"
    ? (eventKind.slice(RUN_EVENT_KIND_PREFIX.length) as RunState)
    : undefined;
}

/**
 * The queue state a `queue_item.*` kind announces, or `undefined` for any other
 * kind.
 *
 * The record's whole reason for being keyed by kind rather than being a list,
 * exposed: the queue's first row is `queue_item.created` and the state it announces
 * is `queued`.
 */
export function runQueueStreamStateFor(eventKind: string): QueueItemState | undefined {
  return readFrozenRecord(RUN_QUEUE_STREAM_STATE_BY_KIND, eventKind);
}

/** The registered stream this subscription name is, or `undefined` if it is not one. */
export function sessionEventStreamFor(
  subscriptionName: string,
): ConsoleSessionEventStream | undefined {
  return readFrozenRecord(CONSOLE_SESSION_EVENT_STREAMS, subscriptionName);
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
  return stream.carriedKinds.includes(eventKind);
}

/**
 * One row of a keyed table, looked up by a wire-verbatim string.
 *
 * `Object.hasOwn` rather than a bare indexed read, and one helper rather than the
 * same widened-view dance written out at each of the four call sites: the argument
 * is a string that arrived off the wire, so `"constructor"` and `"toString"` reach
 * these lookups exactly as a real kind does, and an indexed read would answer one
 * of them with something off `Object.prototype` — a truthy value where the caller
 * is asking whether the table has a row at all.
 */
function readFrozenRecord<Row>(table: Readonly<Record<string, Row>>, key: string): Row | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}
