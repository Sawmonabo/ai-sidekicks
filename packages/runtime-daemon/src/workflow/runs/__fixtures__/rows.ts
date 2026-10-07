// Raw-SQL rows the run store's tests build on: a workflow with one version, a repository checkout a
// run's execution context names, runs created through the creation statements, steps and form
// drafts as the engine would write them, and a full read of a run's rows for comparing before and
// after.

import type { Database } from "better-sqlite3";

import { foldName } from "@ai-sidekicks/contracts/name-fold";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { WorkflowNodeId } from "@ai-sidekicks/contracts/workflow/definition/document";
import type { WorkflowRunId } from "@ai-sidekicks/contracts/workflow/run/id";
import type {
  WorkflowRunStatus,
  WorkflowStepStatus,
} from "@ai-sidekicks/contracts/workflow/run/status";

import type { DatabaseWriter } from "../../../database/writer.js";
import { mintUuidV7 } from "../../../uuid-v7.js";
import {
  workflowRunCreationStatements,
  type WorkflowRunChainPlace,
  type WorkflowRunExecutionContext,
} from "../creation.js";

type Writer = Pick<DatabaseWriter, "write">;

// The session every fixture run lives in.
const FIXTURE_SESSION_ID = "00000000-0000-7000-8000-000000000001" as SessionId;

// The node every fixture step runs, as the fixture version's body names it.
const FIXTURE_NODE_ID = "approve" as WorkflowNodeId;

const EMPTY_PAYLOAD_REF = JSON.stringify({ kind: "inline", items: [] });

/**
 * Stores a workflow named `name` with one version whose body holds the fixture node, and resolves
 * with the version's id.
 */
export async function insertWorkflowVersion(writer: Writer, name: string): Promise<string> {
  const definitionId = mintUuidV7();
  const versionId = mintUuidV7();
  const body = JSON.stringify({
    schemaVersion: "2",
    name,
    trigger: { id: "start", kind: "trigger.manual", kindVersion: 1, name: "Start", order: 0 },
    nodes: [{ id: FIXTURE_NODE_ID, kind: "human.approval", kindVersion: 1, name: "Approve" }],
    edges: [],
  });
  const contentHash = `b3:${"0".repeat(64)}`;
  const createdAt = "2026-10-01T00:00:00.000Z";
  await writer.write([
    {
      sql: `INSERT INTO workflow_definitions (
          id, name, name_folded, content_hash, schema_version, definition_body, created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, '2', ?, ?, ?)`,
      bindings: [definitionId, name, foldName(name), contentHash, body, createdAt, createdAt],
    },
    {
      sql: `INSERT INTO workflow_versions (
          id, definition_id, version_number, content_hash, definition_body, created_at
        ) VALUES (?, ?, 1, ?, ?, ?)`,
      bindings: [versionId, definitionId, contentHash, body, createdAt],
    },
  ]);
  return versionId;
}

/** Stores a repository checkout a run's execution context can name, and resolves with it. */
export async function insertExecutionContextCheckout(
  writer: Writer,
): Promise<WorkflowRunExecutionContext> {
  const repoMountId = mintUuidV7();
  const workspaceId = mintUuidV7();
  const branchContextId = mintUuidV7();
  const at = "2026-10-01T00:00:00.000Z";
  await writer.write([
    {
      sql: `INSERT INTO repo_mounts (
          id, node_id, local_path, canonical_root, attached_at, updated_at
        ) VALUES (?, 'node', '/repo', '/repo', ?, ?)`,
      bindings: [repoMountId, at, at],
    },
    {
      sql: `INSERT INTO workspaces (
          id, session_id, repo_mount_id, execution_mode, fs_root, state, created_at, updated_at
        ) VALUES (?, ?, ?, 'bound-root', '/repo', 'ready', ?, ?)`,
      bindings: [workspaceId, FIXTURE_SESSION_ID, repoMountId, at, at],
    },
    {
      sql: `INSERT INTO branch_contexts (
          id, workspace_id, base_branch, head_branch, created_at, updated_at
        ) VALUES (?, ?, 'main', 'main', ?, ?)`,
      bindings: [branchContextId, workspaceId, at, at],
    },
  ]);
  return {
    workspaceId,
    executionMode: "bound-root",
    executionRoot: "/repo",
    branchContextId,
    gitCommonDir: "/repo/.git",
  };
}

// What a fixture run is created with beyond its version; each member has a default.
interface FixtureRunOptions {
  readonly chain?: WorkflowRunChainPlace;
  readonly executionContext?: WorkflowRunExecutionContext;
  readonly createdAt?: Date;
}

/** Creates a run of `workflowVersionId` through the creation statements; resolves with its id. */
export async function createFixtureRun(
  writer: Writer,
  workflowVersionId: string,
  options: FixtureRunOptions = {},
): Promise<WorkflowRunId> {
  const workflowRunId = mintUuidV7() as WorkflowRunId;
  await writer.write(
    workflowRunCreationStatements({
      workflowRunId,
      workflowVersionId,
      sessionId: FIXTURE_SESSION_ID,
      mode: "manual",
      trigger: { kind: "trigger.manual", nodeId: "start" as WorkflowNodeId },
      startedBy: { kind: "schedule" },
      chain: options.chain ?? { kind: "starts" },
      executionContext: options.executionContext,
      createdAt: options.createdAt ?? new Date("2026-10-02T00:00:00.000Z"),
    }),
  );
  return workflowRunId;
}

/** Moves a run to `status`, started at `startedAt` and, where given, ended at `finishedAt`. */
export async function setFixtureRunStatus(
  writer: Writer,
  workflowRunId: WorkflowRunId,
  status: WorkflowRunStatus,
  startedAt: string,
  finishedAt: string | null,
): Promise<void> {
  await writer.write([
    {
      sql: "UPDATE workflow_runs SET status = ?, started_at = ?, finished_at = ? WHERE id = ?",
      bindings: [status, startedAt, finishedAt, workflowRunId],
      expectedRowCount: 1,
    },
  ]);
}

/** A step as a fixture writes it; a waiting step names its cause and its account or deadline. */
export interface FixtureStep {
  readonly executionIndex: number;
  readonly status: WorkflowStepStatus;
  readonly waitCause?: "approval" | "account";
  readonly waitAccountId?: string;
  readonly resumeAt?: string;
  readonly waitDeadlineAt?: string;
}

/** Stores `step` in `workflowRunId` as the engine would. */
export async function insertFixtureStep(
  writer: Writer,
  workflowRunId: WorkflowRunId,
  step: FixtureStep,
): Promise<void> {
  await writer.write([
    {
      sql: `INSERT INTO workflow_steps (
          workflow_run_id, node_id, attempt, execution_index, status, wait_cause, resume_at,
          wait_account_id, wait_deadline_at, started_at, input_ref, output_ref, log_ref
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, '2026-10-02T00:00:01.000Z', ?, ?, ?)`,
      bindings: [
        workflowRunId,
        FIXTURE_NODE_ID,
        step.executionIndex,
        step.status,
        step.waitCause ?? null,
        step.resumeAt ?? null,
        step.waitAccountId ?? null,
        step.waitDeadlineAt ?? null,
        EMPTY_PAYLOAD_REF,
        EMPTY_PAYLOAD_REF,
        EMPTY_PAYLOAD_REF,
      ],
    },
  ]);
}

/** Stores a form draft for the fixture node in `workflowRunId`. */
export async function insertFixtureFormDraft(
  writer: Writer,
  workflowRunId: WorkflowRunId,
): Promise<void> {
  await writer.write([
    {
      sql: `INSERT INTO human_phase_form_state (
          id, workflow_run_id, node_id, created_at, updated_at
        ) VALUES (?, ?, ?, '2026-10-02T00:00:02.000Z', '2026-10-02T00:00:02.000Z')`,
      bindings: [mintUuidV7(), workflowRunId, FIXTURE_NODE_ID],
    },
  ]);
}

/**
 * Every row stored for `workflowRunId`: the run's own, its steps, its form drafts and its
 * execution context, each in a stable order, so two reads compare whole.
 */
export function readRunRows(database: Database, workflowRunId: WorkflowRunId): unknown {
  return {
    run: database.prepare("SELECT * FROM workflow_runs WHERE id = ?").all(workflowRunId),
    steps: database
      .prepare("SELECT * FROM workflow_steps WHERE workflow_run_id = ? ORDER BY execution_index")
      .all(workflowRunId),
    formDrafts: database
      .prepare("SELECT * FROM human_phase_form_state WHERE workflow_run_id = ? ORDER BY id")
      .all(workflowRunId),
    executionContext: database
      .prepare("SELECT * FROM run_execution_contexts WHERE run_id = ?")
      .all(workflowRunId),
  };
}
