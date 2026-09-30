// Where a run stands, the one closed set every run shape reads. It sits below the
// run modules because `run-control.ts` composes `run-children.ts` at module scope
// and both read it, so neither can hold it without an import cycle.
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
