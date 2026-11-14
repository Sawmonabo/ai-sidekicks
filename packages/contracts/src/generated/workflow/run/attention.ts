// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The runs-needing-you section: the runs waiting on a person and the runs a spent provider account holds, in the order `Next waiting` walks them.

import type { WireInstant } from "../../internal/wire-scalars.js";
import type { WorkflowRunId } from "./id.js";
import type { WorkflowSpentAccount } from "./step/record.js";

/**
 * What a run waiting on a person waits on: every wait cause but a spent provider account, which
 * nobody can answer.
 */
export type WorkflowPersonWaitCause = "approval" | "form" | "reply" | "chain";
/**
 * One line of the runs-needing-you section. A run waiting on a person is its own line; the runs
 * held by one spent provider account fold into one line keyed by that account, since nobody can
 * answer them.
 */
export type WorkflowRunAttentionEntry =
  | {
      kind: "run";
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
      /**
       * Its workflow's name.
       */
      workflowName: string;
      /**
       * What it waits on.
       */
      waitCause: WorkflowPersonWaitCause;
      /**
       * The name of the step that waits.
       */
      waitingStepName: string;
      /**
       * Since when it waits.
       */
      waitingSince: WireInstant;
    }
  | {
      kind: "account";
      /**
       * The account, named as the steps waiting on it name it.
       */
      account: WorkflowSpentAccount;
      /**
       * How many runs it holds.
       */
      affectedRunCount: number;
      /**
       * Since when the oldest of them waits.
       */
      waitingSince: WireInstant;
      /**
       * When the wait resumes itself, where one is armed.
       */
      resumeAt?: WireInstant;
    };

/**
 * The `workflow.run.attention.list` result: every account line first, then the runs waiting on a
 * person, oldest first, the order `Next waiting` walks them in. `waitingOnPersonCount` counts
 * those runs; an account wait is never in it.
 */
export interface WorkflowRunAttentionListResponse {
  /**
   * The lines.
   */
  entries: WorkflowRunAttentionEntry[];
  /**
   * How many runs wait on a person.
   */
  waitingOnPersonCount: number;
}

export {
  validateWorkflowPersonWaitCause,
  validateWorkflowRunAttentionEntry,
  validateWorkflowRunAttentionListResponse,
} from "../../checks/workflow/run/attention.js";
