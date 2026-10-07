// Every move a run's state may make, as data: the one table the engine checks a change against
// before it writes, and the states a run ends in.

import type { RunStateChangeState } from "@ai-sidekicks/contracts/run/events";
import type { RunState } from "@ai-sidekicks/contracts/run/state";

/** The states a run ends in; the event entering one is the terminal record of its run version. */
export const RUN_TERMINAL_STATES = ["completed", "interrupted", "stopped", "failed"] as const;

/** A state a run ends in. */
export type RunTerminalState = (typeof RUN_TERMINAL_STATES)[number];

// The states each state may move to. A move several triggers share, such as `running -> failed`
// on an error during execution or at a restart, is one entry.
const NEXT_STATES_BY_STATE: { readonly [From in RunState]: readonly RunStateChangeState[] } = {
  queued: ["starting", "failed"],
  starting: ["running", "failed", "interrupted", "waiting_for_input"],
  running: [
    "waiting_for_approval",
    "waiting_for_input",
    "pausing",
    "interrupted",
    "completed",
    "failed",
    "stopped",
  ],
  waiting_for_approval: ["running", "interrupted", "failed", "waiting_for_input"],
  waiting_for_input: ["running", "interrupted", "failed"],
  pausing: ["paused", "running", "interrupted", "failed"],
  paused: ["running", "interrupted", "failed", "waiting_for_input"],
  completed: ["running"],
  interrupted: ["running", "stopped"],
  stopped: ["running"],
  failed: [],
};

/** Whether `state` is one a run ends in. */
export function isTerminalState(state: RunState): state is RunTerminalState {
  return (RUN_TERMINAL_STATES as readonly RunState[]).includes(state);
}

/** The states from which a run may move to `to`. */
export function statesThatMayEnter(to: RunStateChangeState): RunState[] {
  return (Object.keys(NEXT_STATES_BY_STATE) as RunState[]).filter((from) =>
    NEXT_STATES_BY_STATE[from].includes(to),
  );
}

/** Whether a run in `from` may move to `to`. */
export function isTransitionAllowed(from: RunState, to: RunStateChangeState): boolean {
  return NEXT_STATES_BY_STATE[from].includes(to);
}
