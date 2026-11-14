// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The statuses every workflow run method and event shares: the run's, each step's, and what a waiting step waits on.

/** Every run status, in the order a screen lists them. */
export const WORKFLOW_RUN_STATUSES = [
  "new",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "canceled",
  "crashed",
] as const;

/** The statuses of a run that is still going: new, running or waiting. */
export const GOING_RUN_STATUSES = ["new", "running", "waiting"] as const;

/** Every step status. */
export const WORKFLOW_STEP_STATUSES = [
  "pending",
  "running",
  "waiting",
  "waitingMemory",
  "succeeded",
  "failed",
  "skipped",
  "canceled",
] as const;

/** Every wait cause. */
export const WORKFLOW_WAIT_CAUSES = ["approval", "form", "reply", "account", "chain"] as const;

/**
 * A run's status; no screen shows any other. `waiting` covers a run held by a person, a chain's
 * question or a spent provider account; it is never swept to `crashed` when the daemon starts and
 * never pruned, so a waiting run survives a restart.
 */
export type WorkflowRunStatus =
  | "new"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "canceled"
  | "crashed";
/**
 * The status of one step, meaning one execution of one node. `waiting` is a step held for a
 * person, a chain's question or a spent account; `waitingMemory` is a step the memory gate has
 * not started yet, which needs nobody. `canceled` is a step that was running or waiting when its
 * run ended failed or canceled, or a branch a first-to-arrive merge stopped.
 */
export type WorkflowStepStatus =
  | "pending"
  | "running"
  | "waiting"
  | "waitingMemory"
  | "succeeded"
  | "failed"
  | "skipped"
  | "canceled";
/**
 * What a waiting step waits on: a person's approval, form or chat reply, its chain's question, or
 * a spent provider account. Only the account wait needs nobody.
 */
export type WorkflowWaitCause = "approval" | "form" | "reply" | "account" | "chain";

export { validateWorkflowRunStatus } from "../../checks/workflow/run/status.js";
