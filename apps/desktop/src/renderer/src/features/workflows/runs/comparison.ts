import type { WorkflowRunSnapshotPoint } from "@ai-sidekicks/contracts/gitflow/local";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { WorkflowRunId } from "@ai-sidekicks/contracts/workflow/run/id";

/**
 * What Review is opened on from a run's page: the run's session, the run, and the two snapshot
 * points compared — start to end on a finished run, start to a pause on an approval step.
 */
export interface WorkflowRunComparison {
  readonly sessionId: SessionId;
  readonly workflowRunId: WorkflowRunId;
  readonly from: WorkflowRunSnapshotPoint;
  readonly to: WorkflowRunSnapshotPoint;
}
