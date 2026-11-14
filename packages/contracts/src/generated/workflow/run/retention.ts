// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Run retention: deleting one run, deleting the runs older than an instant and its preview, and marking a run Keep, which such a delete leaves.

import type { WireInstant } from "../../internal/wire-scalars.js";
import type { WorkflowRunId } from "./id.js";

/**
 * The `workflow.run.delete` input. Deleting a run removes its record, its steps and its recorded
 * snapshots, and cannot be undone; a run that has not ended is refused: cancel it first.
 */
export interface WorkflowRunDeleteRequest {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
}
/**
 * The `workflow.run.delete` result.
 */
export interface WorkflowRunDeleteResponse {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * Always `true`.
   */
  deleted: true;
}
/**
 * The `workflow.run.purge.preview` and `workflow.run.purge` input: the runs that started before
 * this instant. A run marked Keep, one that has not ended, and a chain's first run while a later
 * run of its chain has not ended are never removed.
 */
export interface WorkflowRunPurgeRequest {
  /**
   * The instant.
   */
  olderThan: WireInstant;
}
/**
 * The `workflow.run.purge.preview` result, read before the confirm: how many runs the delete would
 * remove, and how many older runs it would leave because they are kept or waiting.
 */
export interface WorkflowRunPurgePreviewResponse {
  /**
   * The runs it would remove.
   */
  deleteCount: number;
  /**
   * The older runs it would leave because they are marked Keep.
   */
  keptCount: number;
  /**
   * The older runs it would leave because they are waiting.
   */
  waitingCount: number;
}
/**
 * The `workflow.run.purge` result. Runs may start or end between the preview and the delete, so
 * this count, not the preview's, is what was removed.
 */
export interface WorkflowRunPurgeResponse {
  /**
   * The runs removed.
   */
  deletedCount: number;
}
/**
 * The `workflow.run.keep.update` input and result alike: whether the run is marked Keep, which
 * deleting old runs leaves.
 */
export interface WorkflowRunKeepSet {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * Whether it is marked Keep.
   */
  keep: boolean;
}
