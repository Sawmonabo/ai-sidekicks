// What a cancel does to a run's rows: the statements the engine's cancel writes in one unit of
// work with the run's canceled event, and a projection rebuild applies from that event alone.

import type { WorkflowStepError } from "@ai-sidekicks/contracts/workflow/definition/document";
import type { WorkflowRunId } from "@ai-sidekicks/contracts/workflow/run/id";

import type { WriteStatement } from "../../database/statement.js";

/** A cancel as the run's rows record it. */
export interface WorkflowRunCancellation {
  readonly workflowRunId: WorkflowRunId;
  /** When the run ended. */
  readonly finishedAt: Date;
  /** Why it was canceled, where the canceling side says. */
  readonly error?: WorkflowStepError | undefined;
}

const CANCEL_RUN_SQL = `UPDATE workflow_runs
  SET status = 'canceled', finished_at = @finishedAt, error_json = @errorJson
  WHERE id = @workflowRunId`;

// Run-scoped rather than per waiting step: parallel branches wait independently, so every step
// row of the run is cleared, and the step still going reads canceled. SQLite evaluates every SET
// expression against the row as it was, so each CASE reads the old status.
const CANCEL_STEPS_SQL = `UPDATE workflow_steps
  SET status = CASE WHEN status IN ('running', 'waiting', 'waiting-memory')
                    THEN 'canceled' ELSE status END,
      finished_at = CASE WHEN status IN ('running', 'waiting', 'waiting-memory')
                         THEN @finishedAt ELSE finished_at END,
      wait_cause = NULL, resume_at = NULL, wait_deadline_at = NULL, wait_account_id = NULL
  WHERE workflow_run_id = @workflowRunId`;

/**
 * The statements that apply a cancel: the run reads `canceled` with its end, every step still
 * running, waiting or held by the memory gate reads `canceled` with the same end, and no step of
 * the run keeps a wait cause, resume instant, deadline or spent account. They read nothing but
 * the run's id and its end, so applying the same cancel twice leaves the rows as once.
 */
export function workflowRunCancellationStatements(
  cancellation: WorkflowRunCancellation,
): WriteStatement[] {
  const finishedAt = cancellation.finishedAt.toISOString();
  return [
    {
      sql: CANCEL_RUN_SQL,
      bindings: {
        workflowRunId: cancellation.workflowRunId,
        finishedAt,
        errorJson: cancellation.error === undefined ? null : JSON.stringify(cancellation.error),
      },
    },
    {
      sql: CANCEL_STEPS_SQL,
      bindings: { workflowRunId: cancellation.workflowRunId, finishedAt },
    },
  ];
}
