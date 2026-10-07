// Creating a run's row: the statements the engine's run start writes in one unit of work with the
// run's created event, so a run, its place in its chain and its execution context are stored
// together or not at all.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { WorkflowNodeId } from "@ai-sidekicks/contracts/workflow/definition/document";
import type { WorkflowRunId } from "@ai-sidekicks/contracts/workflow/run/id";
import type {
  WorkflowRunMode,
  WorkflowStartedBy,
  WorkflowTriggerKind,
} from "@ai-sidekicks/contracts/workflow/run/trigger";

import type { WriteStatement } from "../../database/statement.js";
import type { PreparedExecutionRoot } from "../../workspace/execution-root-service.js";

/**
 * Which trigger node started a run, stored as the run's trigger record.
 *
 * @consumedBy the engine's run start
 */
export interface WorkflowRunTrigger {
  readonly kind: WorkflowTriggerKind;
  readonly nodeId: WorkflowNodeId;
}

/**
 * A run's place in its chain: it starts a chain of its own, or it joins the chain whose first run
 * is `chainRootRunId`, through an error trigger when `isFromError`.
 */
export type WorkflowRunChainPlace =
  | { readonly kind: "starts" }
  | {
      readonly kind: "joins";
      readonly chainRootRunId: WorkflowRunId;
      readonly isFromError: boolean;
    };

/**
 * The execution context of a run that works in a project's repository: the checkout the engine
 * prepared for it and that repository's git common folder.
 */
export type WorkflowRunExecutionContext = Pick<
  PreparedExecutionRoot,
  "workspaceId" | "executionMode" | "executionRoot" | "worktreeId" | "branchContextId"
> & {
  /** `git rev-parse --git-common-dir`, absolute, read when the context was prepared. */
  readonly gitCommonDir: string;
};

/** Everything a new run's row is written from; the run starts `new`, not yet started. */
export interface WorkflowRunCreation {
  readonly workflowRunId: WorkflowRunId;
  /** The version the run pins for its whole life. */
  readonly workflowVersionId: string;
  readonly sessionId: SessionId;
  readonly mode: WorkflowRunMode;
  readonly trigger: WorkflowRunTrigger;
  readonly startedBy: WorkflowStartedBy;
  readonly chain: WorkflowRunChainPlace;
  /** Present only for a run that works in a project's repository. */
  readonly executionContext?: WorkflowRunExecutionContext | undefined;
  readonly createdAt: Date;
}

const INSERT_RUN_SQL = `INSERT INTO workflow_runs (
    id, workflow_version_id, session_id, status, mode, trigger_json, started_by,
    chain_root_run_id, chain_from_error, chain_run_count, chain_kept_going, kept, created_at
  ) VALUES (
    @id, @workflowVersionId, @sessionId, 'new', @mode, @triggerJson, @startedBy,
    @chainRootRunId, @chainFromError, @chainRunCount, @chainKeptGoing, 0, @createdAt
  )`;

// Only a chain's first run counts, so a root that is gone or is not a first run matches no row.
const COUNT_CHAIN_RUN_SQL = `UPDATE workflow_runs SET chain_run_count = chain_run_count + 1
  WHERE id = ? AND chain_run_count IS NOT NULL`;

const INSERT_EXECUTION_CONTEXT_SQL = `INSERT INTO run_execution_contexts (
    run_id, session_id, workspace_id, execution_mode, execution_root, git_common_dir,
    worktree_id, branch_context_id, created_at
  ) VALUES (
    @runId, @sessionId, @workspaceId, @executionMode, @executionRoot, @gitCommonDir,
    @worktreeId, @branchContextId, @createdAt
  )`;

/**
 * The statements that store a new run: its row, pinned to its version and its session; for a run
 * that joins a chain, one more on the chain's count on the first run's row, which refuses the
 * write when that row is not a stored first run; and its execution context's row where it has
 * one. A first run's own row counts itself.
 */
export function workflowRunCreationStatements(creation: WorkflowRunCreation): WriteStatement[] {
  const createdAt = creation.createdAt.toISOString();
  const startsChain = creation.chain.kind === "starts";
  const statements: WriteStatement[] = [
    {
      sql: INSERT_RUN_SQL,
      bindings: {
        id: creation.workflowRunId,
        workflowVersionId: creation.workflowVersionId,
        sessionId: creation.sessionId,
        mode: creation.mode,
        triggerJson: JSON.stringify(creation.trigger),
        startedBy: JSON.stringify(creation.startedBy),
        chainRootRunId:
          creation.chain.kind === "starts" ? creation.workflowRunId : creation.chain.chainRootRunId,
        chainFromError: creation.chain.kind === "joins" && creation.chain.isFromError ? 1 : 0,
        chainRunCount: startsChain ? 1 : null,
        chainKeptGoing: startsChain ? 0 : null,
        createdAt,
      },
      expectedRowCount: 1,
    },
  ];
  if (creation.chain.kind === "joins") {
    statements.push({
      sql: COUNT_CHAIN_RUN_SQL,
      bindings: [creation.chain.chainRootRunId],
      expectedRowCount: 1,
    });
  }
  const context = creation.executionContext;
  if (context !== undefined) {
    statements.push({
      sql: INSERT_EXECUTION_CONTEXT_SQL,
      bindings: {
        runId: creation.workflowRunId,
        sessionId: creation.sessionId,
        workspaceId: context.workspaceId,
        executionMode: context.executionMode,
        executionRoot: context.executionRoot,
        gitCommonDir: context.gitCommonDir,
        worktreeId: context.worktreeId ?? null,
        branchContextId: context.branchContextId,
        createdAt,
      },
      expectedRowCount: 1,
    });
  }
  return statements;
}
