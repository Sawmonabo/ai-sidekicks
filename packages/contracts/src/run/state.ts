// Lives below the run modules: `run/control.ts` composes `run/children.ts` at module scope and
// both read the state, so neither can own it without an import cycle.
import { z } from "zod";

const RUN_STATE_VALUES = [
  "queued",
  "starting",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
  "pausing",
  "paused",
  "completed",
  "interrupted",
  "stopped",
  "failed",
] as const;

/**
 * Where a run stands. `pausing` is the step in flight finishing after a pause was
 * asked for; the run reads `paused` once nothing runs. `stopped` is a child ended by a stop
 * that reached several agents: final on Claude Code, resumable by a send on Codex.
 */
export type RunState = (typeof RUN_STATE_VALUES)[number];
/** Parses a {@link RunState}. */
export const RunStateSchema: z.ZodType<RunState, RunState> = z.enum(RUN_STATE_VALUES);

/**
 * The state a run is created in. No state change enters it, so the event entering it creates a run.
 */
export const RUN_INITIAL_STATE: "queued" = "queued" satisfies RunState;

/** The states a run ends in; the event entering one is the terminal record of its run version. */
export const RUN_TERMINAL_STATES: readonly RunTerminalState[] = [
  "completed",
  "interrupted",
  "stopped",
  "failed",
];

/** A state a run ends in. */
export type RunTerminalState = Extract<
  RunState,
  "completed" | "interrupted" | "stopped" | "failed"
>;

/** Whether `state` is one a run ends in. */
export function isTerminalState(state: RunState): state is RunTerminalState {
  return (RUN_TERMINAL_STATES as readonly RunState[]).includes(state);
}
