// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The runs table's page: the `workflow.run.list` filters, one row per run and the count of every run the filters match.

import type { WireInstant } from "../../internal/wire-scalars.js";
import type { SessionId } from "../../session/id.js";
import type { WorkflowDefinitionId, WorkflowVersionId } from "../definition/document.js";
import type { WorkflowRunId } from "./id.js";
import type { WorkflowLiveStep } from "./records.js";
import type { WorkflowRunStatus } from "./status.js";
import type { WorkflowCost } from "./step/record.js";
import type { WorkflowRunMode, WorkflowStartedBy, WorkflowTriggerKind } from "./trigger.js";

/**
 * Where the next `workflow.run.list` page starts. The daemon writes it and owns its format; a
 * client passes it back unchanged with the same filters.
 */
export type WorkflowRunListCursor = string & { readonly __brand: "WorkflowRunListCursor" };
/**
 * One row of the runs table, told apart by its `status`, carrying no version (the run's own page
 * reads it). A going run carries its live step and no duration, an ended one its duration, and a
 * failed run parked on its failed step neither.
 */
export type WorkflowRunSummary =
  | {
      status: "new";
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
      /**
       * The session it lives in, which the row opens.
       */
      sessionId: SessionId;
      /**
       * The workflow it came from, since a list answers with runs nobody named.
       */
      definitionId: WorkflowDefinitionId;
      /**
       * That workflow's name.
       */
      definitionName: string;
      /**
       * How it was started.
       */
      mode: WorkflowRunMode;
      /**
       * The kind of trigger node that started it, which the trigger column reads.
       */
      triggerKind: WorkflowTriggerKind;
      /**
       * Who or what started it.
       */
      startedBy: WorkflowStartedBy;
      /**
       * When it started.
       */
      startedAt: WireInstant;
      /**
       * How many steps it has run.
       */
      stepCount: number;
      /**
       * What it cost, with the account that paid; absent where no provider was billed.
       */
      cost?: WorkflowCost;
      /**
       * The Keep mark the row shows.
       */
      keep: boolean;
      /**
       * The run's own summary line, which a `Write a summary` step writes; absent until one
       * does.
       */
      summary?: string;
      /**
       * Never present: a going run has not ended.
       */
      durationMs?: never;
      /**
       * The step it is on.
       */
      liveStep?: WorkflowLiveStep;
      /**
       * Never present: only a waiting run names a cause.
       */
      waitCause?: never;
      /**
       * Never present: only an account wait resumes itself.
       */
      resumeAt?: never;
    }
  | {
      status: "running";
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
      /**
       * The session it lives in, which the row opens.
       */
      sessionId: SessionId;
      /**
       * The workflow it came from, since a list answers with runs nobody named.
       */
      definitionId: WorkflowDefinitionId;
      /**
       * That workflow's name.
       */
      definitionName: string;
      /**
       * How it was started.
       */
      mode: WorkflowRunMode;
      /**
       * The kind of trigger node that started it, which the trigger column reads.
       */
      triggerKind: WorkflowTriggerKind;
      /**
       * Who or what started it.
       */
      startedBy: WorkflowStartedBy;
      /**
       * When it started.
       */
      startedAt: WireInstant;
      /**
       * How many steps it has run.
       */
      stepCount: number;
      /**
       * What it cost, with the account that paid; absent where no provider was billed.
       */
      cost?: WorkflowCost;
      /**
       * The Keep mark the row shows.
       */
      keep: boolean;
      /**
       * The run's own summary line, which a `Write a summary` step writes; absent until one
       * does.
       */
      summary?: string;
      /**
       * Never present: a going run has not ended.
       */
      durationMs?: never;
      /**
       * The step it is on.
       */
      liveStep?: WorkflowLiveStep;
      /**
       * Never present: only a waiting run names a cause.
       */
      waitCause?: never;
      /**
       * Never present: only an account wait resumes itself.
       */
      resumeAt?: never;
    }
  | ((
      | {
          waitCause: "approval";
          /**
           * The run.
           */
          workflowRunId: WorkflowRunId;
          /**
           * The session it lives in, which the row opens.
           */
          sessionId: SessionId;
          /**
           * The workflow it came from, since a list answers with runs nobody named.
           */
          definitionId: WorkflowDefinitionId;
          /**
           * That workflow's name.
           */
          definitionName: string;
          /**
           * How it was started.
           */
          mode: WorkflowRunMode;
          /**
           * The kind of trigger node that started it, which the trigger column reads.
           */
          triggerKind: WorkflowTriggerKind;
          /**
           * Who or what started it.
           */
          startedBy: WorkflowStartedBy;
          /**
           * When it started.
           */
          startedAt: WireInstant;
          /**
           * How many steps it has run.
           */
          stepCount: number;
          /**
           * What it cost, with the account that paid; absent where no provider was billed.
           */
          cost?: WorkflowCost;
          /**
           * The Keep mark the row shows.
           */
          keep: boolean;
          /**
           * The run's own summary line, which a `Write a summary` step writes; absent until one
           * does.
           */
          summary?: string;
          /**
           * Never present: a waiting run has not ended.
           */
          durationMs?: never;
          /**
           * The step it is on.
           */
          liveStep?: WorkflowLiveStep;
          /**
           * Never present: only an account wait resumes itself.
           */
          resumeAt?: never;
        }
      | {
          waitCause: "form";
          /**
           * The run.
           */
          workflowRunId: WorkflowRunId;
          /**
           * The session it lives in, which the row opens.
           */
          sessionId: SessionId;
          /**
           * The workflow it came from, since a list answers with runs nobody named.
           */
          definitionId: WorkflowDefinitionId;
          /**
           * That workflow's name.
           */
          definitionName: string;
          /**
           * How it was started.
           */
          mode: WorkflowRunMode;
          /**
           * The kind of trigger node that started it, which the trigger column reads.
           */
          triggerKind: WorkflowTriggerKind;
          /**
           * Who or what started it.
           */
          startedBy: WorkflowStartedBy;
          /**
           * When it started.
           */
          startedAt: WireInstant;
          /**
           * How many steps it has run.
           */
          stepCount: number;
          /**
           * What it cost, with the account that paid; absent where no provider was billed.
           */
          cost?: WorkflowCost;
          /**
           * The Keep mark the row shows.
           */
          keep: boolean;
          /**
           * The run's own summary line, which a `Write a summary` step writes; absent until one
           * does.
           */
          summary?: string;
          /**
           * Never present: a waiting run has not ended.
           */
          durationMs?: never;
          /**
           * The step it is on.
           */
          liveStep?: WorkflowLiveStep;
          /**
           * Never present: only an account wait resumes itself.
           */
          resumeAt?: never;
        }
      | {
          waitCause: "reply";
          /**
           * The run.
           */
          workflowRunId: WorkflowRunId;
          /**
           * The session it lives in, which the row opens.
           */
          sessionId: SessionId;
          /**
           * The workflow it came from, since a list answers with runs nobody named.
           */
          definitionId: WorkflowDefinitionId;
          /**
           * That workflow's name.
           */
          definitionName: string;
          /**
           * How it was started.
           */
          mode: WorkflowRunMode;
          /**
           * The kind of trigger node that started it, which the trigger column reads.
           */
          triggerKind: WorkflowTriggerKind;
          /**
           * Who or what started it.
           */
          startedBy: WorkflowStartedBy;
          /**
           * When it started.
           */
          startedAt: WireInstant;
          /**
           * How many steps it has run.
           */
          stepCount: number;
          /**
           * What it cost, with the account that paid; absent where no provider was billed.
           */
          cost?: WorkflowCost;
          /**
           * The Keep mark the row shows.
           */
          keep: boolean;
          /**
           * The run's own summary line, which a `Write a summary` step writes; absent until one
           * does.
           */
          summary?: string;
          /**
           * Never present: a waiting run has not ended.
           */
          durationMs?: never;
          /**
           * The step it is on.
           */
          liveStep?: WorkflowLiveStep;
          /**
           * Never present: only an account wait resumes itself.
           */
          resumeAt?: never;
        }
      | {
          waitCause: "account";
          /**
           * The run.
           */
          workflowRunId: WorkflowRunId;
          /**
           * The session it lives in, which the row opens.
           */
          sessionId: SessionId;
          /**
           * The workflow it came from, since a list answers with runs nobody named.
           */
          definitionId: WorkflowDefinitionId;
          /**
           * That workflow's name.
           */
          definitionName: string;
          /**
           * How it was started.
           */
          mode: WorkflowRunMode;
          /**
           * The kind of trigger node that started it, which the trigger column reads.
           */
          triggerKind: WorkflowTriggerKind;
          /**
           * Who or what started it.
           */
          startedBy: WorkflowStartedBy;
          /**
           * When it started.
           */
          startedAt: WireInstant;
          /**
           * How many steps it has run.
           */
          stepCount: number;
          /**
           * What it cost, with the account that paid; absent where no provider was billed.
           */
          cost?: WorkflowCost;
          /**
           * The Keep mark the row shows.
           */
          keep: boolean;
          /**
           * The run's own summary line, which a `Write a summary` step writes; absent until one
           * does.
           */
          summary?: string;
          /**
           * Never present: a waiting run has not ended.
           */
          durationMs?: never;
          /**
           * The step it is on.
           */
          liveStep?: WorkflowLiveStep;
          /**
           * When the wait resumes itself, where one is armed.
           */
          resumeAt?: WireInstant;
        }
      | {
          waitCause: "chain";
          /**
           * The run.
           */
          workflowRunId: WorkflowRunId;
          /**
           * The session it lives in, which the row opens.
           */
          sessionId: SessionId;
          /**
           * The workflow it came from, since a list answers with runs nobody named.
           */
          definitionId: WorkflowDefinitionId;
          /**
           * That workflow's name.
           */
          definitionName: string;
          /**
           * How it was started.
           */
          mode: WorkflowRunMode;
          /**
           * The kind of trigger node that started it, which the trigger column reads.
           */
          triggerKind: WorkflowTriggerKind;
          /**
           * Who or what started it.
           */
          startedBy: WorkflowStartedBy;
          /**
           * When it started.
           */
          startedAt: WireInstant;
          /**
           * How many steps it has run.
           */
          stepCount: number;
          /**
           * What it cost, with the account that paid; absent where no provider was billed.
           */
          cost?: WorkflowCost;
          /**
           * The Keep mark the row shows.
           */
          keep: boolean;
          /**
           * The run's own summary line, which a `Write a summary` step writes; absent until one
           * does.
           */
          summary?: string;
          /**
           * Never present: a waiting run has not ended.
           */
          durationMs?: never;
          /**
           * The step it is on.
           */
          liveStep?: WorkflowLiveStep;
          /**
           * Never present: only an account wait resumes itself.
           */
          resumeAt?: never;
        }
    ) & {
      status: "waiting";
    })
  | {
      status: "succeeded";
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
      /**
       * The session it lives in, which the row opens.
       */
      sessionId: SessionId;
      /**
       * The workflow it came from, since a list answers with runs nobody named.
       */
      definitionId: WorkflowDefinitionId;
      /**
       * That workflow's name.
       */
      definitionName: string;
      /**
       * How it was started.
       */
      mode: WorkflowRunMode;
      /**
       * The kind of trigger node that started it, which the trigger column reads.
       */
      triggerKind: WorkflowTriggerKind;
      /**
       * Who or what started it.
       */
      startedBy: WorkflowStartedBy;
      /**
       * When it started.
       */
      startedAt: WireInstant;
      /**
       * How many steps it has run.
       */
      stepCount: number;
      /**
       * What it cost, with the account that paid; absent where no provider was billed.
       */
      cost?: WorkflowCost;
      /**
       * The Keep mark the row shows.
       */
      keep: boolean;
      /**
       * The run's own summary line, which a `Write a summary` step writes; absent until one
       * does.
       */
      summary?: string;
      /**
       * How long it ran, in milliseconds.
       */
      durationMs: number;
      /**
       * Never present: only a going run has a live step.
       */
      liveStep?: never;
      /**
       * Never present: only a waiting run names a cause.
       */
      waitCause?: never;
      /**
       * Never present: only an account wait resumes itself.
       */
      resumeAt?: never;
    }
  | {
      status: "failed";
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
      /**
       * The session it lives in, which the row opens.
       */
      sessionId: SessionId;
      /**
       * The workflow it came from, since a list answers with runs nobody named.
       */
      definitionId: WorkflowDefinitionId;
      /**
       * That workflow's name.
       */
      definitionName: string;
      /**
       * How it was started.
       */
      mode: WorkflowRunMode;
      /**
       * The kind of trigger node that started it, which the trigger column reads.
       */
      triggerKind: WorkflowTriggerKind;
      /**
       * Who or what started it.
       */
      startedBy: WorkflowStartedBy;
      /**
       * When it started.
       */
      startedAt: WireInstant;
      /**
       * How many steps it has run.
       */
      stepCount: number;
      /**
       * What it cost, with the account that paid; absent where no provider was billed.
       */
      cost?: WorkflowCost;
      /**
       * The Keep mark the row shows.
       */
      keep: boolean;
      /**
       * The run's own summary line, which a `Write a summary` step writes; absent until one
       * does.
       */
      summary?: string;
      /**
       * How long it ran, in milliseconds; absent while it is parked on its failed step.
       */
      durationMs?: number;
      /**
       * Never present: only a going run has a live step.
       */
      liveStep?: never;
      /**
       * Never present: only a waiting run names a cause.
       */
      waitCause?: never;
      /**
       * Never present: only an account wait resumes itself.
       */
      resumeAt?: never;
    }
  | {
      status: "canceled";
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
      /**
       * The session it lives in, which the row opens.
       */
      sessionId: SessionId;
      /**
       * The workflow it came from, since a list answers with runs nobody named.
       */
      definitionId: WorkflowDefinitionId;
      /**
       * That workflow's name.
       */
      definitionName: string;
      /**
       * How it was started.
       */
      mode: WorkflowRunMode;
      /**
       * The kind of trigger node that started it, which the trigger column reads.
       */
      triggerKind: WorkflowTriggerKind;
      /**
       * Who or what started it.
       */
      startedBy: WorkflowStartedBy;
      /**
       * When it started.
       */
      startedAt: WireInstant;
      /**
       * How many steps it has run.
       */
      stepCount: number;
      /**
       * What it cost, with the account that paid; absent where no provider was billed.
       */
      cost?: WorkflowCost;
      /**
       * The Keep mark the row shows.
       */
      keep: boolean;
      /**
       * The run's own summary line, which a `Write a summary` step writes; absent until one
       * does.
       */
      summary?: string;
      /**
       * How long it ran, in milliseconds.
       */
      durationMs: number;
      /**
       * Never present: only a going run has a live step.
       */
      liveStep?: never;
      /**
       * Never present: only a waiting run names a cause.
       */
      waitCause?: never;
      /**
       * Never present: only an account wait resumes itself.
       */
      resumeAt?: never;
    }
  | {
      status: "crashed";
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
      /**
       * The session it lives in, which the row opens.
       */
      sessionId: SessionId;
      /**
       * The workflow it came from, since a list answers with runs nobody named.
       */
      definitionId: WorkflowDefinitionId;
      /**
       * That workflow's name.
       */
      definitionName: string;
      /**
       * How it was started.
       */
      mode: WorkflowRunMode;
      /**
       * The kind of trigger node that started it, which the trigger column reads.
       */
      triggerKind: WorkflowTriggerKind;
      /**
       * Who or what started it.
       */
      startedBy: WorkflowStartedBy;
      /**
       * When it started.
       */
      startedAt: WireInstant;
      /**
       * How many steps it has run.
       */
      stepCount: number;
      /**
       * What it cost, with the account that paid; absent where no provider was billed.
       */
      cost?: WorkflowCost;
      /**
       * The Keep mark the row shows.
       */
      keep: boolean;
      /**
       * The run's own summary line, which a `Write a summary` step writes; absent until one
       * does.
       */
      summary?: string;
      /**
       * How long it ran, in milliseconds.
       */
      durationMs: number;
      /**
       * Never present: only a going run has a live step.
       */
      liveStep?: never;
      /**
       * Never present: only a waiting run names a cause.
       */
      waitCause?: never;
      /**
       * Never present: only an account wait resumes itself.
       */
      resumeAt?: never;
    };

/**
 * The `workflow.run.list` input: the runs table's filters (workflow, status, trigger kind and date
 * range) and the version scope `Show runs` hands in, which comes only with the workflow it belongs
 * to. Without `sessionId` it lists every run this daemon ran.
 */
export interface WorkflowRunListRequest {
  /**
   * The session whose runs are listed; absent, every run this daemon ran.
   */
  sessionId?: SessionId;
  /**
   * The workflow whose runs are listed.
   */
  definitionId?: WorkflowDefinitionId;
  /**
   * Only runs pinned to this version of that workflow; sent only with `definitionId`.
   */
  workflowVersionId?: WorkflowVersionId;
  /**
   * Only runs in one of these statuses.
   *
   * @minItems 1
   */
  status?: [WorkflowRunStatus, ...WorkflowRunStatus[]];
  /**
   * Only runs started by one of these trigger kinds.
   *
   * @minItems 1
   */
  triggerKind?: [WorkflowTriggerKind, ...WorkflowTriggerKind[]];
  /**
   * Only runs started after this instant.
   */
  startedAfter?: WireInstant;
  /**
   * Only runs started before this instant.
   */
  startedBefore?: WireInstant;
  /**
   * The most runs on one page.
   */
  limit?: number;
  /**
   * Continue from this cursor.
   */
  cursor?: WorkflowRunListCursor;
}
/**
 * The `workflow.run.list` result: one page of runs, each listed once across pages, and how many
 * runs the filters match in all, which the tab's count reads; never fewer than the page holds.
 */
export interface WorkflowRunListResponse {
  /**
   * The page's runs.
   */
  runs: WorkflowRunSummary[];
  /**
   * Where the next page starts; absent on the last page.
   */
  nextCursor?: WorkflowRunListCursor;
  /**
   * How many runs the filters match in all.
   */
  totalCount: number;
}

export {
  validateWorkflowRunListCursor,
  validateWorkflowRunListRequest,
  validateWorkflowRunListResponse,
  validateWorkflowRunSummary,
} from "../../checks/workflow/run/list.js";
