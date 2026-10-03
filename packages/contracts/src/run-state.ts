// Lives below the run modules: `run-control.ts` composes `run-children.ts` at module scope and
// both read the state, so neither can own it without an import cycle.
import { z } from "zod";

/**
 * Where a run stands. `pausing` is the step in flight finishing after a pause was
 * asked for; the run reads `paused` once nothing runs.
 */
export type RunState =
  | "queued"
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "pausing"
  | "paused"
  | "completed"
  | "interrupted"
  | "failed";
/** Parses a {@link RunState}. */
export const RunStateSchema: z.ZodType<RunState, RunState> = z.enum([
  "queued",
  "starting",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
  "pausing",
  "paused",
  "completed",
  "interrupted",
  "failed",
]);
