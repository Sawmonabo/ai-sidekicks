// The run-state event kinds and the state each announces, listed once. A `run.<state>` kind
// announces the state it names, and `satisfies` makes a newly registered state, or a kind the
// contract does not register, a compile error. The contract import is type-only: a value import
// would pull the event taxonomy and its schemas into the shipped bundle.

import type { RunState } from "@ai-sidekicks/contracts/run/state";
import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";

import { readFrozenRecord } from "#renderer/lib/frozen-record.js";

/** The state a run is created in. No transition ends in it, so `run.queued` is a creation. */
export const RUN_INITIAL_STATE: "queued" = "queued" satisfies RunState;

/** The kind of the event that creates a run, the one that can bring its agent into the session. */
export const RUN_QUEUED_EVENT_KIND: Extract<SessionEventType, "run.queued"> =
  `run.${RUN_INITIAL_STATE}`;

/** The kind of the event that moves a run into a state: every state but the initial one. */
export type RunStateTransitionKind = Extract<
  SessionEventType,
  `run.${Exclude<RunState, typeof RUN_INITIAL_STATE>}`
>;

type RunStateKind = Extract<SessionEventType, `run.${RunState}`>;

const RUN_STATE_BY_KIND: Readonly<Record<RunStateKind, RunState>> = Object.freeze({
  "run.queued": "queued",
  "run.starting": "starting",
  "run.running": "running",
  "run.waiting_for_approval": "waiting_for_approval",
  "run.waiting_for_input": "waiting_for_input",
  "run.pausing": "pausing",
  "run.paused": "paused",
  "run.completed": "completed",
  "run.interrupted": "interrupted",
  "run.stopped": "stopped",
  "run.failed": "failed",
} satisfies Record<RunStateKind, RunState>);

/**
 * Every run-state event kind, in the order the contract declares the states. Strings rather
 * than the union, because a caller tests a wire-verbatim kind for membership.
 */
export const RUN_STATE_KINDS: readonly string[] = Object.freeze(Object.keys(RUN_STATE_BY_KIND));

/** The run state a state-change kind announces, or `undefined` for any other (`run.queued` too). */
export function runStateForTransitionKind(eventKind: string): RunState | undefined {
  const state = readFrozenRecord(RUN_STATE_BY_KIND, eventKind);
  return state === RUN_INITIAL_STATE ? undefined : state;
}
