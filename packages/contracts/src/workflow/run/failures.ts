// The refusal every run method shares and the codes a failed step carries, each with the details
// that ride the failed step's error and its failed event.
import { z } from "zod";

import { ProviderNameSchema, type ProviderName } from "../../provider/name.js";

// Refusals every run method shares

/**
 * A workflow definition or run that does not exist.
 */
export const WORKFLOW_NOT_FOUND_CODE = "workflow.not_found" as const;

// Step failures: each rides the failed step's error and its failed event

/**
 * A step cut by a time limit: its own `Timeout`, or the run's cap.
 */
export const WORKFLOW_STEP_TIMED_OUT_CODE = "workflow.step_timed_out" as const;
/** Which limit cut the step. */
export const WORKFLOW_STEP_TIMED_OUT_CAUSES = ["step_timeout", "run_cap"] as const;
/** One of {@link WORKFLOW_STEP_TIMED_OUT_CAUSES}. */
export type WorkflowStepTimedOutCause = (typeof WORKFLOW_STEP_TIMED_OUT_CAUSES)[number];
/** The time-limit failure's details: which limit, and the limit itself in milliseconds. */
export interface WorkflowStepTimedOutDetails {
  cause: WorkflowStepTimedOutCause;
  limitMs: number;
}
/**
 * Wire schema for {@link WorkflowStepTimedOutDetails}.
 *
 * @consumedBy the handler that returns the `workflow.step_timed_out` error
 */
export const WorkflowStepTimedOutDetailsSchema: z.ZodType<WorkflowStepTimedOutDetails> = z
  .object({
    cause: z.enum(WORKFLOW_STEP_TIMED_OUT_CAUSES),
    limitMs: z.number().int().positive(),
  })
  .strict();

/**
 * A quick step's or an expression's thread that ended without an answer.
 */
export const WORKFLOW_STEP_THREAD_FAILED_CODE = "workflow.step_thread_failed" as const;
/**
 * Why the thread ended: its host ran out of heap, it was not running 5 s after its start, or it
 * exited without an answer.
 */
export const WORKFLOW_STEP_THREAD_FAILED_REASONS = [
  "out_of_memory",
  "start_timeout",
  "exited",
] as const;
/** One of {@link WORKFLOW_STEP_THREAD_FAILED_REASONS}. */
export type WorkflowStepThreadFailedReason = (typeof WORKFLOW_STEP_THREAD_FAILED_REASONS)[number];
/** The thread failure's details: why the thread ended. */
export interface WorkflowStepThreadFailedDetails {
  reason: WorkflowStepThreadFailedReason;
}
/**
 * Wire schema for {@link WorkflowStepThreadFailedDetails}.
 *
 * @consumedBy the handler that returns the `workflow.step_thread_failed` error
 */
export const WorkflowStepThreadFailedDetailsSchema: z.ZodType<WorkflowStepThreadFailedDetails> = z
  .object({ reason: z.enum(WORKFLOW_STEP_THREAD_FAILED_REASONS) })
  .strict();

/**
 * A full-tier Code step or a sandboxed shell step whose provider sandbox did not start.
 * The step never runs unprotected instead.
 */
export const WORKFLOW_SANDBOX_UNAVAILABLE_CODE = "workflow.sandbox_unavailable" as const;
/** The sandbox failure's details: whose sandbox, and its wrapper's own error. */
export interface WorkflowSandboxUnavailableDetails {
  provider: ProviderName;
  detail: string;
}
/**
 * Wire schema for {@link WorkflowSandboxUnavailableDetails}.
 *
 * @consumedBy the handler that returns the `workflow.sandbox_unavailable` error
 */
export const WorkflowSandboxUnavailableDetailsSchema: z.ZodType<WorkflowSandboxUnavailableDetails> =
  z.object({ provider: ProviderNameSchema, detail: z.string().min(1) }).strict();

/**
 * A full-tier Code step whose package install did not finish.
 *
 * @consumedBy the handler that returns the `workflow.code_install_failed` error
 */
export const WORKFLOW_CODE_INSTALL_FAILED_CODE = "workflow.code_install_failed" as const;
/**
 * Why the install failed: too little disk to hold it, or any other install error,
 * a stale lock included.
 */
export const WORKFLOW_CODE_INSTALL_FAILED_REASONS = ["disk_space", "tool_error"] as const;
/** One of {@link WORKFLOW_CODE_INSTALL_FAILED_REASONS}. */
export type WorkflowCodeInstallFailedReason = (typeof WORKFLOW_CODE_INSTALL_FAILED_REASONS)[number];
/** The install failure's details: the reason and the installer's own error. */
export interface WorkflowCodeInstallFailedDetails {
  reason: WorkflowCodeInstallFailedReason;
  detail: string;
}
/**
 * Wire schema for {@link WorkflowCodeInstallFailedDetails}.
 *
 * @consumedBy the handler that returns the `workflow.code_install_failed` error
 */
export const WorkflowCodeInstallFailedDetailsSchema: z.ZodType<WorkflowCodeInstallFailedDetails> = z
  .object({ reason: z.enum(WORKFLOW_CODE_INSTALL_FAILED_REASONS), detail: z.string().min(1) })
  .strict();

/**
 * A Code step over its memory budget; a deadline cut is `workflow.step_timed_out` instead.
 *
 * @consumedBy the handler that returns the `workflow.code_over_budget` error
 */
export const WORKFLOW_CODE_OVER_BUDGET_CODE = "workflow.code_over_budget" as const;
