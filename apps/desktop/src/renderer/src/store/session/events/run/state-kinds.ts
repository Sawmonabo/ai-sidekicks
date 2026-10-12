// The run-state event kinds as the store reads them: the kind that creates a run and the state a
// later kind moves it into, both derived from the contract's one table of `run.<state>` types.

import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import { RUN_INITIAL_STATE, type RunState } from "@ai-sidekicks/contracts/run/state";
import { runStateOfEventType } from "@ai-sidekicks/contracts/transcript/run-facts";

/** The kind of the event that creates a run, the one that can bring its agent into the session. */
export const RUN_QUEUED_EVENT_KIND: Extract<SessionEventType, "run.queued"> =
  `run.${RUN_INITIAL_STATE}`;

/** The kind of the event that moves a run into a state: every state but the initial one. */
export type RunStateTransitionKind = Extract<
  SessionEventType,
  `run.${Exclude<RunState, typeof RUN_INITIAL_STATE>}`
>;

/** The run state a state-change kind announces, or `undefined` for any other (`run.queued` too). */
export function runStateForTransitionKind(eventKind: string): RunState | undefined {
  const state = runStateOfEventType(eventKind);
  return state === RUN_INITIAL_STATE ? undefined : state;
}
