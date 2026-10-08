// What a cancel does to a run's rows: the statements the engine's cancel writes in one unit of
// work with the run's canceled event, and a projection rebuild applies from that event alone.

import type { WorkflowStepError } from "@ai-sidekicks/contracts/workflow/definition/document";
import type { WorkflowRunId } from "@ai-sidekicks/contracts/workflow/run/id";

import type { WriteStatement } from "../../database/statement.js";
import { GOING_RUN_STATUSES_SQL, parkedFailedRunCondition } from "./record.js";

/** A cancel as the run's rows record it. */
export interface WorkflowRunCancellation {
  readonly workflowRunId: WorkflowRunId;
  /** When the run ended. */
  readonly finishedAt: Date;
  /** Why it was canceled, where the canceling side says. */
  readonly error?: WorkflowStepError | undefined;
}

// Matches only a run that can be canceled: one still going, or a failed run parked on its failed
// step. A run that has ended matches nothing, so its end is never overwritten.
const CANCEL_RUN_SQL = `UPDATE workflow_runs AS run
  SET status = 'canceled', finished_at = @finishedAt, error_json = @errorJson
  WHERE run.id = @workflowRunId
    AND (run.status IN (${GOING_RUN_STATUSES_SQL}) OR ${parkedFailedRunCondition("run")})`;

// Run-scoped rather than per waiting step: parallel branches wait independently, so every step
// row of the run is cleared, and a step still going reads canceled while a pending one stays
// pending. SQLite evaluates every SET expression against the row as it was, so each CASE reads
// the old status.
const CANCEL_STEPS_SQL = `UPDATE workflow_steps
  SET status = CASE WHEN status IN ('running', 'waiting', 'waiting-memory')
                    THEN 'canceled' ELSE status END,
      finished_at = CASE WHEN status IN ('running', 'waiting', 'waiting-memory')
                         THEN @finishedAt ELSE finished_at END,
      wait_cause = NULL, resume_at = NULL, wait_deadline_at = NULL, wait_account_id = NULL,
      wait_started_at = NULL
  WHERE workflow_run_id = @workflowRunId`;

/**
 * The statements that apply a cancel: the run reads `canceled` with its end, every step still
 * running, waiting or held by the memory gate reads `canceled` with the same end, and no step of
 * the run keeps a wait cause, wait start, resume instant, deadline or spent account. The write is
 * refused, changing nothing, unless the run is still going or parked on a failed step.
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
      expectedRowCount: 1,
    },
    {
      sql: CANCEL_STEPS_SQL,
      bindings: { workflowRunId: cancellation.workflowRunId, finishedAt },
    },
  ];
}
