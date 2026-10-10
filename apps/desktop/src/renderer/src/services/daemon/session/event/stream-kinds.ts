// The event kinds each narrowed `daemon.subscribe` stream carries, and what a carried kind
// announces. `streams.ts` builds its routing rows from these lists.
//
// Every kind is a key of a record checked with `satisfies Record<...>` against a union derived from
// the contracts census, so a newly registered run state or queue row fails the compile. The census
// import is type-only to keep the taxonomy out of the initial bundle. The tables are frozen records
// and arrays, not `Set`s or `Map`s, so nothing in the process can add a kind and re-route every
// subscription.

import type { QueueItemState } from "@ai-sidekicks/contracts/run/queue";
import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import { RUN_STATE_EVENT_TYPES } from "@ai-sidekicks/contracts/transcript/run-facts";

import { readFrozenRecord } from "#renderer/lib/frozen-record.js";
import {
  runStateForTransitionKind,
  type RunStateTransitionKind,
} from "#renderer/store/session/events/run/state-kinds.js";

/**
 * The event kinds `run.subscribeState` projects: every run state a run can transition into, plus
 * `run.rolled_back`.
 *
 * `run.rolled_back` is the stream's second arm and records no state change. `run.queued` and the
 * other forward run rows (provider initialization, turn start, worker shutdown) are absent because
 * neither arm can represent them; the run-and-queue scenario check subtracts this type from the
 * `run.` census to hold each of those to its own payload.
 */
export type RunStateStreamKind =
  | RunStateTransitionKind
  | Extract<SessionEventType, "run.rolled_back">;

/**
 * Which of the stream's two wire arms a kind is projected into. Whatever builds an arm reads this
 * table, so the arm is decided in one place.
 */
export type RunStateStreamArm = "state-change" | "rollback";

/** The arm table: state changes ride `state-change`, and `run.rolled_back` rides `rollback`. */
const RUN_STATE_STREAM_ARM_BY_KIND: Readonly<Record<string, RunStateStreamArm>> = Object.freeze(
  Object.fromEntries<RunStateStreamArm>([
    ...RUN_STATE_EVENT_TYPES.filter((kind) => runStateForTransitionKind(kind) !== undefined).map(
      (kind): [string, RunStateStreamArm] => [kind, "state-change"],
    ),
    ["run.rolled_back", "rollback"] satisfies [RunStateStreamKind, RunStateStreamArm],
  ]),
);

/**
 * The event kinds `run.subscribeQueue` projects, each mapped to the queue state it announces.
 *
 * A record rather than a list because the name and the state differ: `queue_item.created`
 * announces `queued`.
 */
type RunQueueStreamKind = Extract<SessionEventType, `queue_item.${string}`>;

const RUN_QUEUE_STREAM_STATE_BY_KIND: Readonly<Record<RunQueueStreamKind, QueueItemState>> =
  Object.freeze({
    "queue_item.created": "queued",
    "queue_item.admitted": "admitted",
    "queue_item.superseded": "superseded",
    "queue_item.canceled": "canceled",
    "queue_item.not_delivered": "not_delivered",
  } satisfies Record<RunQueueStreamKind, QueueItemState>);

/**
 * The kinds `run.subscribeState` carries.
 *
 * Typed as strings because a subscriber's event `kind` arrives wire-verbatim. A frozen array, so a
 * caller cannot add to it.
 */
export const RUN_STATE_STREAM_CARRIED_KINDS: readonly string[] = Object.freeze(
  Object.keys(RUN_STATE_STREAM_ARM_BY_KIND),
);

/** The kinds `run.subscribeQueue` carries, frozen like the list above. */
export const RUN_QUEUE_STREAM_CARRIED_KINDS: readonly string[] = Object.freeze(
  Object.keys(RUN_QUEUE_STREAM_STATE_BY_KIND),
);

/**
 * The wire arm of `run.subscribeState` this event kind travels as, or `undefined` when the stream
 * does not carry it.
 */
export function runStateStreamArmFor(eventKind: string): RunStateStreamArm | undefined {
  return readFrozenRecord(RUN_STATE_STREAM_ARM_BY_KIND, eventKind);
}

/**
 * The queue state a `queue_item.*` kind announces, or `undefined` for any other kind. For example
 * `queue_item.created` announces `queued`.
 */
export function runQueueStreamStateFor(eventKind: string): QueueItemState | undefined {
  return readFrozenRecord(RUN_QUEUE_STREAM_STATE_BY_KIND, eventKind);
}
