// Which event kinds each narrowed `daemon.subscribe` stream projects, and what a
// carried kind announces.
//
// The tables `session-event-streams.ts` routes with, held one module down from the
// routing itself. That module says which subscription names the corpus registers and
// what a name delivers; this one says which kinds each narrowed stream carries and
// what a carried kind announces about the run or the queue row underneath it. The
// routing table composes its rows out of the kind lists below rather than restating
// them, so a kind that joins or leaves a stream moves across both without anyone
// editing a second list.
//
// WHERE THE ROWS COME FROM. Each list is read off the subscription's own
// registration rather than chosen here:
//
//   • `run.subscribeState` — streams `RunStateChangeEvent | RunRolledBackEvent`.
//     The first arm is one event per canonical run state the machine can transition
//     INTO, so its kinds are the registered `RunState` union under the `run.` root
//     less the initial state; the second arm is the forward, non-state
//     `run.rolled_back` row that the same registration names as riding the same
//     stream.
//   • `run.subscribeQueue` — streams the `QueueItemSummary` projection, which is
//     what each `queue_item.*` row announces, so its kinds are that root within
//     the registered census.
//   • `presence.subscribe` — the session's Awareness room. Its kinds are the
//     `presence.` root — the four transitions that move the room — and what it
//     delivers is a payload-free CHANGE SIGNAL rather than any of them, because the
//     read is the truth and the push is only a signal.
//
// `session.subscribe` has no list here at all, and the absence is the honest shape
// rather than a gap: the set it would enumerate is the entire registered census,
// which this module cannot hold as a runtime value without pulling the taxonomy into
// the renderer bundle — and a routing rule that answers "yes" for every kind needs no
// set to answer with.
//
// HOW THE KINDS STAY BOUND TO THE WIRE. Every kind below is a member of a record
// declared `satisfies Record<<derived kind union>, …>`, and each union is
// `Extract`ed from the contracts census (`SessionEventType`) intersected with the
// registered vocabulary the stream projects (`RunState`, the `queue_item.` root).
// Totality and excess are therefore both compile-time facts: a newly registered
// run state or queue row fails this file, and a kind this table invents fails it
// too. The import stays TYPE-ONLY — the renderer's initial-bundle budget is
// enforced and this module is on the RELEASE path, reached from the routing table
// and the binder one family up, so a value import of the census would pull the whole
// taxonomy module and its schemas into the shipped console — and the runtime
// cross-check against `SESSION_EVENT_CATEGORY_BY_TYPE` therefore lives in the
// co-located test, which is not bundled and can read the census itself.
//
// WHY EVERY COLLECTION HERE IS A FROZEN RECORD OR A FROZEN ARRAY, AND NOT A `Set`
// OR A `Map`. These tables are compile-time constants that every subscription in a
// renderer routes through, and the kind lists used to be exported as `ReadonlySet`
// views over mutable `Set`s with a module-level `Map` and `Set` beside them.
// `ReadonlySet` is a TypeScript view and nothing more: the lists are exported, so
// one `carriedKinds.add(…)` anywhere in the process would have re-routed EVERY
// fixture subscription in that renderer for the rest of its life, and no compiler
// and no test would have said so. Module-level mutable singletons are rejected
// outright by `apps/desktop/AGENTS.md` §State and views for exactly that reason.
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
 * this" would be the drift this seam was written to end, one layer up.
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
 * The registered event kinds that move a session's Awareness room.
 *
 * The `presence.` root of the census, `Extract`ed rather than listed, so a presence
 * transition the corpus registers later is carried without anyone editing this file.
 * The value is `true` and carries no meaning of its own: the room's whole reading
 * comes from `presence.read`, so what a kind announces here is only THAT the room
 * moved.
 */
type PresenceStreamKind = Extract<SessionEventType, `presence.${string}`>;

const PRESENCE_STREAM_SIGNAL_BY_KIND: Readonly<Record<PresenceStreamKind, true>> = Object.freeze({
  "presence.online": true,
  "presence.idle": true,
  "presence.reconnecting": true,
  "presence.offline": true,
} satisfies Record<PresenceStreamKind, true>);

/**
 * The kinds `run.subscribeState` carries, read off the record that declares them.
 *
 * Typed as strings rather than as the union, because a subscriber's event `kind`
 * arrives wire-verbatim: the membership test the routing table runs IS what
 * recognises it, and the registration proof lives on the record above rather than on
 * this list. A frozen array rather than a `ReadonlySet`, because the readonly view
 * was the defect — nine members are a `.includes` away, and the array cannot be added
 * to by a caller that got hold of it.
 */
export const RUN_STATE_STREAM_CARRIED_KINDS: readonly string[] = Object.freeze(
  Object.keys(RUN_STATE_STREAM_ARM_BY_KIND),
);

/** The kinds `run.subscribeQueue` carries. Frozen, for the list above's reason. */
export const RUN_QUEUE_STREAM_CARRIED_KINDS: readonly string[] = Object.freeze(
  Object.keys(RUN_QUEUE_STREAM_STATE_BY_KIND),
);

/**
 * The log-borne half of when a session's Awareness room moves.
 *
 * Half rather than all of it: the room also moves when what a person is DOING
 * changes, which the census carries no event for at all, so whatever serves that
 * subscription owns the other half. Frozen, for the list above's reason.
 */
export const PRESENCE_STREAM_CARRIED_KINDS: readonly string[] = Object.freeze(
  Object.keys(PRESENCE_STREAM_SIGNAL_BY_KIND),
);

/**
 * Which registered arm of `run.subscribeState` this event kind travels as, or
 * `undefined` when the stream does not carry the kind at all.
 */
export function runStateStreamArmFor(eventKind: string): RunStateStreamArm | undefined {
  return readFrozenRecord(RUN_STATE_STREAM_ARM_BY_KIND, eventKind);
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

/**
 * One row of a keyed table, looked up by a wire-verbatim string.
 *
 * `Object.hasOwn` rather than a bare indexed read, and one helper rather than the
 * same widened-view dance written out at each call site: the argument is a string
 * that arrived off the wire, so `"constructor"` and `"toString"` reach these lookups
 * exactly as a real kind does, and an indexed read would answer one of them with
 * something off `Object.prototype` — a truthy value where the caller is asking
 * whether the table has a row at all.
 *
 * Exported for the one caller outside this file, `session-event-streams.ts`, which
 * asks the same question of the subscription table it keys by NAME. Both halves of
 * this seam are looked up by a string a subscriber supplied, so writing the guard
 * twice would be two spellings of one rule — and the second spelling is the one that
 * forgets the prototype.
 */
export function readFrozenRecord<Row>(
  table: Readonly<Record<string, Row>>,
  key: string,
): Row | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}
