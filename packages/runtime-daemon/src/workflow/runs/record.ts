// A run and its steps as their rows store them, and the mapping from those rows. A run's read
// and the runs list share the run's mapping; the run read alone carries the steps.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type {
  WorkflowDefinitionId,
  WorkflowNodeId,
  WorkflowStepError,
} from "@ai-sidekicks/contracts/workflow/definition/document";
import type { ProviderAccountId } from "@ai-sidekicks/contracts/provider/account/record";
import type { WorkflowRunId } from "@ai-sidekicks/contracts/workflow/run/id";
import type { WorkflowChainRoot, WorkflowRun } from "@ai-sidekicks/contracts/workflow/run/records";
import type {
  WorkflowRunStatus,
  WorkflowStepStatus,
  WorkflowWaitCause,
} from "@ai-sidekicks/contracts/workflow/run/status";
import type {
  WorkflowPayloadRef,
  WorkflowSpentAccount,
  WorkflowStep,
  WorkflowStepSource,
} from "@ai-sidekicks/contracts/workflow/run/step/record";
import type {
  WorkflowRunMode,
  WorkflowStartedBy,
  WorkflowTriggerKind,
} from "@ai-sidekicks/contracts/workflow/run/trigger";

import { spentAccountFromColumns, type SpentAccountColumns } from "./spent-account.js";

/**
 * One run as its row stores it. `startedAt` is absent while the run is `new`, and `finishedAt`
 * once present is when the run ended; `error` says why a failed, canceled or crashed run ended.
 */
export type StoredWorkflowRun = Pick<
  WorkflowRun,
  | "workflowRunId"
  | "sessionId"
  | "definitionId"
  | "workflowVersionId"
  | "mode"
  | "triggerKind"
  | "startedBy"
  | "keep"
> & {
  status: WorkflowRunStatus;
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
  error?: WorkflowStepError | undefined;
};

/**
 * One step as its row stores it. The wait members are present only while the step is `waiting`,
 * because the table clears them in the statement that moves a step out of `waiting`.
 */
export type StoredWorkflowStep = Pick<
  WorkflowStep,
  | "workflowRunId"
  | "nodeId"
  | "attempt"
  | "executionIndex"
  | "source"
  | "startedAt"
  | "finishedAt"
  | "inputRef"
  | "outputRef"
  | "logRef"
  | "cost"
  | "error"
  | "advisories"
> & {
  status: WorkflowStepStatus;
  waitCause?: WorkflowWaitCause | undefined;
  /** The spent account an `account` wait waits on. */
  waitAccount?: WorkflowSpentAccount | undefined;
  /** The instant an `account` wait resumes itself, where one is armed. */
  resumeAt?: string | undefined;
  /** The instant a wait on a person gives up, where its `Timeout` set one. */
  waitDeadlineAt?: string | undefined;
};

/**
 * The first run of a run's chain, as the rows hold it: its start is absent while it is still
 * `new`, which only a first run reading itself can see.
 */
export type StoredWorkflowChainRoot = Omit<WorkflowChainRoot, "startedAt"> & {
  startedAt?: string | undefined;
};

/**
 * `instant` in the `toISOString` form every run and step instant is stored in, so the two compare
 * as text; a request's instant may carry an offset, which would compare wrongly as written.
 */
export function storedInstant(instant: string): string {
  return new Date(instant).toISOString();
}

/** The run's columns every run read selects, as {@link RUN_COLUMNS} names them. */
export interface RunColumns {
  readonly run_id: string;
  readonly session_id: string;
  readonly definition_id: string;
  readonly workflow_version_id: string;
  readonly status: WorkflowRunStatus;
  readonly mode: WorkflowRunMode;
  readonly trigger_kind: WorkflowTriggerKind;
  readonly started_by: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly error_json: string | null;
  readonly kept: 0 | 1;
  readonly created_at: string;
}

/**
 * The select-list that reads {@link RunColumns} from `workflow_runs AS run` joined to its pinned
 * `workflow_versions AS version`.
 */
export const RUN_COLUMNS = `run.id AS run_id, run.session_id, version.definition_id,
  run.workflow_version_id, run.status, run.mode,
  json_extract(run.trigger_json, '$.kind') AS trigger_kind, run.started_by, run.started_at,
  run.finished_at, run.error_json, run.kept, run.created_at`;

/** The run its columns describe. */
export function storedRunFromColumns(columns: RunColumns): StoredWorkflowRun {
  // Every JSON column here was written by this store from a typed value, so it is read back as one.
  return {
    workflowRunId: columns.run_id as WorkflowRunId,
    sessionId: columns.session_id as SessionId,
    definitionId: columns.definition_id as WorkflowDefinitionId,
    workflowVersionId: columns.workflow_version_id,
    status: columns.status,
    mode: columns.mode,
    triggerKind: columns.trigger_kind,
    startedBy: JSON.parse(columns.started_by) as WorkflowStartedBy,
    keep: columns.kept === 1,
    startedAt: columns.started_at ?? undefined,
    finishedAt: columns.finished_at ?? undefined,
    error:
      columns.error_json === null
        ? undefined
        : (JSON.parse(columns.error_json) as WorkflowStepError),
  };
}

/** A step's columns, as {@link STEP_COLUMNS} names them, with its spent account's. */
export interface StepColumns extends SpentAccountColumns {
  readonly step_node_id: string;
  readonly step_attempt: number;
  readonly step_execution_index: number;
  readonly step_source_json: string;
  readonly step_status: WorkflowStepStatus;
  readonly step_wait_cause: WorkflowWaitCause | null;
  readonly step_resume_at: string | null;
  readonly step_wait_account_id: string | null;
  readonly step_wait_deadline_at: string | null;
  readonly step_started_at: string;
  readonly step_finished_at: string | null;
  readonly step_input_ref: string;
  readonly step_output_ref: string;
  readonly step_log_ref: string;
  readonly step_cost_usd_micros: number | null;
  readonly step_cost_account_id: string | null;
  readonly step_error_json: string | null;
  readonly step_advisories_json: string | null;
}

/** The select-list that reads {@link StepColumns}'s own columns from `workflow_steps AS step`. */
export const STEP_COLUMNS = `step.node_id AS step_node_id, step.attempt AS step_attempt,
  step.execution_index AS step_execution_index, step.source_json AS step_source_json,
  step.status AS step_status, step.wait_cause AS step_wait_cause,
  step.resume_at AS step_resume_at, step.wait_account_id AS step_wait_account_id,
  step.wait_deadline_at AS step_wait_deadline_at, step.started_at AS step_started_at,
  step.finished_at AS step_finished_at, step.input_ref AS step_input_ref,
  step.output_ref AS step_output_ref, step.log_ref AS step_log_ref,
  step.cost_usd_micros AS step_cost_usd_micros, step.cost_account_id AS step_cost_account_id,
  step.error_json AS step_error_json, step.advisories_json AS step_advisories_json`;

/** The step its columns describe, in the run `workflowRunId`. */
export function storedStepFromColumns(
  workflowRunId: WorkflowRunId,
  columns: StepColumns,
): StoredWorkflowStep {
  return {
    workflowRunId,
    nodeId: columns.step_node_id as WorkflowNodeId,
    attempt: columns.step_attempt,
    executionIndex: columns.step_execution_index,
    source: JSON.parse(columns.step_source_json) as (WorkflowStepSource | null)[],
    status: columns.step_status,
    startedAt: columns.step_started_at,
    finishedAt: columns.step_finished_at ?? undefined,
    inputRef: JSON.parse(columns.step_input_ref) as WorkflowPayloadRef,
    outputRef: JSON.parse(columns.step_output_ref) as WorkflowPayloadRef,
    logRef: JSON.parse(columns.step_log_ref) as WorkflowPayloadRef,
    // The table pairs the amount with the account that paid it, so either column decides.
    cost:
      columns.step_cost_usd_micros === null || columns.step_cost_account_id === null
        ? undefined
        : {
            usdMicros: columns.step_cost_usd_micros,
            providerAccountId: columns.step_cost_account_id as ProviderAccountId,
          },
    error:
      columns.step_error_json === null
        ? undefined
        : (JSON.parse(columns.step_error_json) as WorkflowStepError),
    advisories:
      columns.step_advisories_json === null
        ? undefined
        : (JSON.parse(columns.step_advisories_json) as string[]),
    waitCause: columns.step_wait_cause ?? undefined,
    waitAccount:
      columns.step_wait_account_id === null
        ? undefined
        : spentAccountFromColumns(columns.step_wait_account_id, columns),
    resumeAt: columns.step_resume_at ?? undefined,
    waitDeadlineAt: columns.step_wait_deadline_at ?? undefined,
  };
}
