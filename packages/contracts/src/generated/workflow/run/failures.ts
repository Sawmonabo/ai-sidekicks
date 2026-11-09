// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The refusal every run method shares and the codes a failed step carries, each with the details that ride the failed step's error and its failed event.

import type { ProviderId } from "../../provider/id.js";

/** A workflow definition that does not exist. */
export const WORKFLOW_DEFINITION_NOT_FOUND_CODE = "workflow.definition.notFound" as const;

/** A workflow version that does not exist. */
export const WORKFLOW_VERSION_NOT_FOUND_CODE = "workflow.version.notFound" as const;

/** A workflow run that does not exist. */
export const WORKFLOW_RUN_NOT_FOUND_CODE = "workflow.run.notFound" as const;

/** A step key that does not exist in its run. */
export const WORKFLOW_STEP_NOT_FOUND_CODE = "workflow.step.notFound" as const;

/** A step cut by a time limit: its own `Timeout`, or the run's cap. */
export const WORKFLOW_STEP_TIMED_OUT_CODE = "workflow.step.timedOut" as const;

/** Every limit that cuts a step. */
export const WORKFLOW_STEP_TIMED_OUT_CAUSES = ["stepTimeout", "runCap"] as const;

/** A quick step's engine that could not be started. */
export const WORKFLOW_STEP_THREAD_FAILED_CODE = "workflow.step.threadFailed" as const;

/** Every reason a quick step's engine fails. */
export const WORKFLOW_STEP_THREAD_FAILED_REASONS = ["startFailed"] as const;

/** A `Run a command` step whose shell is none the engine writes a filled value's reference for. */
export const WORKFLOW_STEP_SHELL_UNKNOWN_CODE = "workflow.step.shellUnknown" as const;

/**
 * A `Run a command` step whose filled value or environment passes the system's or the shell's
 * bound.
 */
export const WORKFLOW_STEP_VALUE_TOO_LARGE_CODE = "workflow.step.valueTooLarge" as const;

/** Every unit a step value's bound counts in. */
export const WORKFLOW_STEP_VALUE_MEASURES = ["bytes", "utf16Units"] as const;

/**
 * A full-tier Code step or a sandboxed shell step whose provider sandbox did not start; the
 * step never runs unprotected instead.
 */
export const WORKFLOW_SANDBOX_UNAVAILABLE_CODE = "workflow.sandboxUnavailable" as const;

/** A full-tier Code step whose package install did not finish. */
export const WORKFLOW_CODE_INSTALL_FAILED_CODE = "workflow.code.installFailed" as const;

/** Every reason a package install fails. */
export const WORKFLOW_CODE_INSTALL_FAILED_REASONS = ["diskSpace", "toolError"] as const;

/** A Code step over its memory budget; a deadline cut is `workflow.step.timedOut` instead. */
export const WORKFLOW_CODE_OVER_BUDGET_CODE = "workflow.code.overBudget" as const;

/**
 * Which limit cut a step.
 */
export type WorkflowStepTimedOutCause = "stepTimeout" | "runCap";
/**
 * Why a quick step's engine failed: it could not be started.
 */
export type WorkflowStepThreadFailedReason = "startFailed";
/**
 * The unit a filled value's or an environment's bound counts in.
 */
export type WorkflowStepValueMeasure = "bytes" | "utf16Units";
/**
 * Why a full-tier Code step's package install failed: too little disk to hold it, or any other
 * install error, a stale lock included.
 */
export type WorkflowCodeInstallFailedReason = "diskSpace" | "toolError";

/**
 * The time-limit failure's details: which limit, and the limit itself in milliseconds.
 */
export interface WorkflowStepTimedOutDetails {
  /**
   * Which limit cut the step.
   */
  cause: WorkflowStepTimedOutCause;
  /**
   * The limit, in milliseconds.
   */
  limitMs: number;
}
/**
 * The engine failure's details: why the engine failed.
 */
export interface WorkflowStepThreadFailedDetails {
  /**
   * Why the engine failed.
   */
  reason: WorkflowStepThreadFailedReason;
}
/**
 * The sandbox failure's details: whose sandbox, and its wrapper's own error.
 */
export interface WorkflowSandboxUnavailableDetails {
  /**
   * The provider whose sandbox did not start.
   */
  provider: ProviderId;
  /**
   * The sandbox wrapper's own error.
   */
  detail: string;
}
/**
 * The install failure's details: the reason and the installer's own error.
 */
export interface WorkflowCodeInstallFailedDetails {
  /**
   * Why the install failed.
   */
  reason: WorkflowCodeInstallFailedReason;
  /**
   * The installer's own error.
   */
  detail: string;
}
