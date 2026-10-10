// Every move a run's state may make, as data: the one table the engine checks a change against
// before it writes, and the event types that end a run.

import type { RunStateChangeState } from "@ai-sidekicks/contracts/run/events";
import { RUN_TERMINAL_STATES, type RunState } from "@ai-sidekicks/contracts/run/state";

/** The event types that enter a terminal state, one per state: `run.completed` and the rest. */
export const RUN_TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set(
  RUN_TERMINAL_STATES.map((state) => `run.${state}`),
);

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
