// The statuses every workflow run method and event shares: the run's, each step's, and what a
// waiting step waits on. The run methods build on this file, and it imports none of
// them: `workflow/run/control.ts` acts on a run, `workflow/run/records.ts` reads, lists and keeps
// run records, and `workflow/run/step/` holds the step record, one step's methods and its events.
import { z } from "zod";

/**
 * A run's status; no screen shows any other. `waiting` covers a run held by a
 * person, a chain's question or a spent provider account; it is never swept to
 * `crashed` when the daemon starts and never pruned, so a waiting run survives a restart.
 */
export const WORKFLOW_RUN_STATUSES = [
  "new",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "canceled",
  "crashed",
] as const;
/** One of {@link WORKFLOW_RUN_STATUSES}. */
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];
/**
 * Wire schema for {@link WorkflowRunStatus}. A shape that allows only some statuses takes them
 * from it with `extract` or `exclude`, so a renamed status cannot leave a subset behind.
 */
export const WorkflowRunStatusSchema: z.ZodEnum<{ [Status in WorkflowRunStatus]: Status }> =
  z.enum(WORKFLOW_RUN_STATUSES);

/** The statuses of a run that is still going: new, running or waiting. */
export const GOING_RUN_STATUSES: readonly WorkflowRunStatus[] = ["new", "running", "waiting"];

/**
 * The status of one step, meaning one execution of one node. `waiting` is a step held
 * for a person, a chain's question or a spent account; `waiting-memory` is a step the
 * memory gate has not started yet, which needs nobody. `canceled` is a step that was
 * running or waiting when its run ended failed or canceled, or a branch a first-to-arrive merge
 * stopped.
 */
export const WORKFLOW_STEP_STATUSES = [
  "pending",
  "running",
  "waiting",
  "waiting-memory",
  "succeeded",
  "failed",
  "skipped",
  "canceled",
] as const;
/** One of {@link WORKFLOW_STEP_STATUSES}. */
export type WorkflowStepStatus = (typeof WORKFLOW_STEP_STATUSES)[number];
/** Wire schema for {@link WorkflowStepStatus}; a subset of the statuses is taken from it. */
export const WorkflowStepStatusSchema: z.ZodEnum<{ [Status in WorkflowStepStatus]: Status }> =
  z.enum(WORKFLOW_STEP_STATUSES);

/**
 * What a waiting step waits on: a person's approval, form or chat reply, its chain's
 * question, or a spent provider account. Only the account wait needs nobody.
 */
export const WORKFLOW_WAIT_CAUSES = ["approval", "form", "reply", "account", "chain"] as const;
/** One of {@link WORKFLOW_WAIT_CAUSES}. */
export type WorkflowWaitCause = (typeof WORKFLOW_WAIT_CAUSES)[number];
/** Wire schema for {@link WorkflowWaitCause}; a subset of the causes is taken from it. */
export const WorkflowWaitCauseSchema: z.ZodEnum<{ [Cause in WorkflowWaitCause]: Cause }> =
  z.enum(WORKFLOW_WAIT_CAUSES);
