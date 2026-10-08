// Deleting runs and keeping them: one run's delete, `Delete runs older than…` with the preview its
// confirm reads, and the Keep mark that bulk delete leaves. Every delete removes a run's steps, its
// form drafts, its gate answers and its execution context with the run, in one write, and answers
// each deleted run's git common folder, read in that write, so its snapshot refs can be pruned.

import type { Statement } from "better-sqlite3";

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/message";
import type { WorkflowRunId } from "@ai-sidekicks/contracts/workflow/run/id";
import {
  GOING_RUN_STATUSES,
  type WorkflowRunStatus,
} from "@ai-sidekicks/contracts/workflow/run/status";
import {
  WORKFLOW_RUN_NOT_DELETABLE_CODE,
  type WorkflowRunKeepSet,
  type WorkflowRunsDeletePreviewResponse,
} from "@ai-sidekicks/contracts/workflow/run/records";

import type { DatabaseConnections } from "../../database/connections.js";
import type { StatementResult, WriteStatement } from "../../database/statement.js";
import { WriteRefusedError } from "../../database/writer.js";
import { DaemonDomainError } from "../../ipc/domain-error.js";
import { GOING_RUN_STATUSES_SQL, PARKED_FAILED_RUN_CONDITION, storedInstant } from "./record.js";
import { WorkflowNotFoundError } from "../not-found.js";

/**
 * A run a delete removed, with the git common folder its execution context named, or null where it
 * had none; the snapshot cleanup prunes the run's refs there after the rows are gone.
 */
export interface DeletedWorkflowRun {
  readonly workflowRunId: WorkflowRunId;
  readonly gitCommonDir: string | null;
}

// A chain's first run holds the chain's count and its answer, which a later run still going,
// or parked on a failed step can still resume, needs, so the first run is not deleted while one is.
const LATER_CHAIN_RUN_GOING = `EXISTS (SELECT 1 FROM workflow_runs AS later
    WHERE later.chain_root_run_id = run.id AND later.id <> run.id
      AND (later.status IN (${GOING_RUN_STATUSES_SQL})
        OR (later.status = 'failed' AND later.finished_at IS NULL)))`;

// A run that never started is aged by its creation.
const OLD_RUN = "COALESCE(run.started_at, run.created_at) < @olderThan";

// Bulk delete never removes a going run, a failed run parked on its failed step, or a chain's first
// run while a later run of the chain is going; nor a kept run. The preview counts with these same
// conditions, so it counts what the delete removes.
const REMOVABLE_BUT_FOR_KEEP = `${OLD_RUN} AND run.status NOT IN (${GOING_RUN_STATUSES_SQL})
  AND NOT ${PARKED_FAILED_RUN_CONDITION} AND NOT ${LATER_CHAIN_RUN_GOING}`;
const REMOVABLE = `${REMOVABLE_BUT_FOR_KEEP} AND run.kept = 0`;

const PREVIEW_SQL = `SELECT
    COALESCE(SUM(CASE WHEN ${REMOVABLE} THEN 1 ELSE 0 END), 0) AS delete_count,
    COALESCE(SUM(CASE WHEN ${REMOVABLE_BUT_FOR_KEEP} AND run.kept = 1 THEN 1 ELSE 0 END), 0)
      AS kept_count,
    COALESCE(SUM(CASE WHEN ${OLD_RUN}
                       AND (run.status = 'waiting' OR ${PARKED_FAILED_RUN_CONDITION})
                      THEN 1 ELSE 0 END), 0) AS waiting_count
  FROM workflow_runs AS run`;

const REMOVABLE_RUN_IDS = `SELECT run.id FROM workflow_runs AS run WHERE ${REMOVABLE}`;

// Each run with its execution context's git common folder, read before the context's row goes.
const REMOVABLE_RUNS_SQL = `SELECT run.id AS run_id, context.git_common_dir
  FROM workflow_runs AS run
  LEFT JOIN run_execution_contexts AS context ON context.run_id = run.id
  WHERE ${REMOVABLE}`;

// Matches the run, with its git common folder, only while it may be deleted, so a write that
// starts with it refuses a run still going and a chain's first run while a later run is going.
const DELETABLE_RUN_SQL = `SELECT run.id AS run_id, context.git_common_dir
  FROM workflow_runs AS run
  LEFT JOIN run_execution_contexts AS context ON context.run_id = run.id
  WHERE run.id = ? AND run.status NOT IN (${GOING_RUN_STATUSES_SQL})
    AND NOT ${LATER_CHAIN_RUN_GOING}`;

const RUN_STATUS_SQL = "SELECT status FROM workflow_runs WHERE id = ?";

const KEEP_SQL = "UPDATE workflow_runs SET kept = ? WHERE id = ?";

interface PreviewRow {
  readonly delete_count: number;
  readonly kept_count: number;
  readonly waiting_count: number;
}

interface DeletedRunRow {
  readonly run_id: string;
  readonly git_common_dir: string | null;
}

/** Deletes runs, one or many, and sets the Keep mark that bulk delete leaves. */
export class WorkflowRunDeletion {
  readonly #writer: Pick<DatabaseConnections["writer"], "write">;
  readonly #preview: Statement<[{ olderThan: string }], PreviewRow>;
  readonly #readStatus: Statement<[string], { status: WorkflowRunStatus }>;

  constructor(database: DatabaseConnections) {
    this.#writer = database.writer;
    this.#preview = database.reader.prepare(PREVIEW_SQL);
    this.#readStatus = database.reader.prepare(RUN_STATUS_SQL);
  }

  /**
   * Deletes one run with its steps, form drafts, gate answers and execution context. Refuses a
   * `new`, `running` or `waiting` run, and a chain's first run while a later run of its chain is
   * one, with `workflow.run_not_deletable`, and a run there is none of with `workflow.not_found`,
   * deleting nothing either way.
   */
  async delete(workflowRunId: WorkflowRunId): Promise<DeletedWorkflowRun> {
    let results: readonly StatementResult[];
    try {
      results = await this.#writer.write([
        { sql: DELETABLE_RUN_SQL, bindings: [workflowRunId], expectedRowCount: 1 },
        ...runRowDeletions("= ?", [workflowRunId]),
        { sql: "DELETE FROM workflow_runs WHERE id = ?", bindings: [workflowRunId] },
      ]);
    } catch (error) {
      if (error instanceof WriteRefusedError) {
        throw this.#refusal(workflowRunId);
      }
      throw error;
    }
    const [deleted] = deletedRunsFrom(results);
    if (deleted === undefined) {
      throw new Error(`The delete of run ${workflowRunId} read no row`);
    }
    return deleted;
  }

  /**
   * How many runs started before `olderThan`, or created before it where they never started,
   * `Delete runs older than…` would remove; how many it would remove but for their Keep mark; and
   * how many it leaves because they are waiting or parked on a failed step.
   */
  previewDeleteOlderThan(olderThan: string): WorkflowRunsDeletePreviewResponse {
    const counts = this.#preview.get({ olderThan: storedInstant(olderThan) });
    if (counts === undefined) {
      throw new Error("The runs delete preview returned no row");
    }
    return {
      deleteCount: counts.delete_count,
      keptCount: counts.kept_count,
      waitingCount: counts.waiting_count,
    };
  }

  /**
   * Deletes every run the preview counts for deletion, with all its rows, and resolves with each
   * one deleted. A run that started or ended since the preview is counted here as it is now.
   */
  async deleteOlderThan(olderThan: string): Promise<DeletedWorkflowRun[]> {
    const bindings = { olderThan: storedInstant(olderThan) };
    const results = await this.#writer.write([
      { sql: REMOVABLE_RUNS_SQL, bindings },
      ...runRowDeletions(`IN (${REMOVABLE_RUN_IDS})`, bindings),
      { sql: `DELETE FROM workflow_runs WHERE id IN (${REMOVABLE_RUN_IDS})`, bindings },
    ]);
    return deletedRunsFrom(results);
  }

  /** Sets or clears the run's Keep mark; throws `workflow.not_found` for a run there is none of. */
  async setKeep(keepSet: WorkflowRunKeepSet): Promise<WorkflowRunKeepSet> {
    try {
      await this.#writer.write([
        {
          sql: KEEP_SQL,
          bindings: [keepSet.keep ? 1 : 0, keepSet.workflowRunId],
          expectedRowCount: 1,
        },
      ]);
    } catch (error) {
      if (error instanceof WriteRefusedError) {
        throw new WorkflowNotFoundError({ workflowRunId: keepSet.workflowRunId });
      }
      throw error;
    }
    return keepSet;
  }

  // Why a delete was refused, read after the refusal: there is no such run, it is still going, or
  // it is a chain's first run and a later run of the chain is going.
  #refusal(workflowRunId: WorkflowRunId): DaemonDomainError {
    const status = this.#readStatus.get(workflowRunId)?.status;
    if (status === undefined) {
      return new WorkflowNotFoundError({ workflowRunId });
    }
    const message = GOING_RUN_STATUSES.includes(status)
      ? `The run is ${status}. Cancel it first.`
      : "A later run of its chain is still going. Cancel it first.";
    return new DaemonDomainError(message, {
      code: WORKFLOW_RUN_NOT_DELETABLE_CODE,
      jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
      detail: { workflowRunId, status },
    });
  }
}

// The deleted runs a write's first statement read.
function deletedRunsFrom(results: readonly StatementResult[]): DeletedWorkflowRun[] {
  const rows = (results[0]?.rows ?? []) as readonly DeletedRunRow[];
  return rows.map((row) => ({
    workflowRunId: row.run_id as WorkflowRunId,
    gitCommonDir: row.git_common_dir,
  }));
}

// The deletes of every row that hangs off the runs `runMatch` selects, children first so the
// foreign keys hold at every statement.
function runRowDeletions(
  runMatch: string,
  bindings: NonNullable<WriteStatement["bindings"]>,
): WriteStatement[] {
  return [
    { sql: `DELETE FROM workflow_steps WHERE workflow_run_id ${runMatch}`, bindings },
    { sql: `DELETE FROM human_phase_form_state WHERE workflow_run_id ${runMatch}`, bindings },
    { sql: `DELETE FROM workflow_gate_resolutions WHERE workflow_run_id ${runMatch}`, bindings },
    { sql: `DELETE FROM run_execution_contexts WHERE run_id ${runMatch}`, bindings },
  ];
}
