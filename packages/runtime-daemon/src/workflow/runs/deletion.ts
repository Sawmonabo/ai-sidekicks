// Deleting runs and keeping them: one run's delete, `Delete runs older than…` with the preview its
// confirm reads, and the Keep mark that bulk delete leaves. Every delete removes a run's steps, its
// form drafts, its gate answers and its execution context with the run, in one write.

import type { Statement } from "better-sqlite3";

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/message";
import type { WorkflowRunId } from "@ai-sidekicks/contracts/workflow/run/id";
import {
  WORKFLOW_RUN_NOT_DELETABLE_CODE,
  type WorkflowRunKeepSet,
  type WorkflowRunsDeletePreviewResponse,
} from "@ai-sidekicks/contracts/workflow/run/records";

import type { DatabaseConnections } from "../../database/connections.js";
import type { WriteStatement } from "../../database/statement.js";
import { WriteRefusedError } from "../../database/writer.js";
import { DaemonDomainError } from "../../ipc/domain-error.js";
import { storedInstant } from "./record.js";
import { WorkflowNotFoundError } from "../not-found.js";

/** What `Delete runs older than…` removed: the deleted runs' ids. */
export interface WorkflowRunsDeletion {
  readonly deletedRunIds: readonly WorkflowRunId[];
}

// A run still going, or parked on its failed step with no end yet, is never deleted in bulk, nor
// is a kept one. The preview counts with this same condition, so it counts what the delete
// removes.
const OLD_REMOVABLE_RUN_CONDITION = `started_at < @olderThan AND kept = 0
  AND finished_at IS NOT NULL AND status NOT IN ('new', 'running', 'waiting')`;

const PREVIEW_SQL = `SELECT
    COALESCE(SUM(CASE WHEN ${OLD_REMOVABLE_RUN_CONDITION} THEN 1 ELSE 0 END), 0) AS delete_count,
    COALESCE(SUM(CASE WHEN started_at < @olderThan AND kept = 1 THEN 1 ELSE 0 END), 0)
      AS kept_count,
    COALESCE(SUM(CASE WHEN started_at < @olderThan AND kept = 0 AND status = 'waiting'
                      THEN 1 ELSE 0 END), 0) AS waiting_count
  FROM workflow_runs`;

const OLD_REMOVABLE_RUN_IDS = `SELECT id FROM workflow_runs WHERE ${OLD_REMOVABLE_RUN_CONDITION}`;

// Matches the run only while it may be deleted, so a write that starts with it refuses a run
// still going.
const DELETABLE_RUN_SQL = `SELECT 1 FROM workflow_runs
  WHERE id = ? AND status NOT IN ('new', 'running', 'waiting')`;

const RUN_STATUS_SQL = "SELECT status FROM workflow_runs WHERE id = ?";

const KEEP_SQL = "UPDATE workflow_runs SET kept = ? WHERE id = ?";

interface PreviewRow {
  readonly delete_count: number;
  readonly kept_count: number;
  readonly waiting_count: number;
}

/** Deletes runs, one or many, and sets the Keep mark that bulk delete leaves. */
export class WorkflowRunDeletion {
  readonly #writer: Pick<DatabaseConnections["writer"], "write">;
  readonly #preview: Statement<[{ olderThan: string }], PreviewRow>;
  readonly #readStatus: Statement<[string], { status: string }>;

  constructor(database: DatabaseConnections) {
    this.#writer = database.writer;
    this.#preview = database.reader.prepare(PREVIEW_SQL);
    this.#readStatus = database.reader.prepare(RUN_STATUS_SQL);
  }

  /**
   * Deletes one run with its steps, form drafts, gate answers and execution context. Refuses a
   * `new`, `running` or `waiting` run with `workflow.run_not_deletable` and a run there is none
   * of with `workflow.not_found`, deleting nothing either way.
   */
  async delete(workflowRunId: WorkflowRunId): Promise<void> {
    try {
      await this.#writer.write([
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
  }

  /**
   * How many runs started before `olderThan` `Delete runs older than…` would remove, and how many
   * it would leave because they are kept or waiting.
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
   * Deletes every run started before `olderThan` that has ended and is not kept, with all its
   * rows, and resolves with their ids. A run that started or ended since the preview is counted
   * here as it is now.
   */
  async deleteOlderThan(olderThan: string): Promise<WorkflowRunsDeletion> {
    const bindings = { olderThan: storedInstant(olderThan) };
    const results = await this.#writer.write([
      ...runRowDeletions(`IN (${OLD_REMOVABLE_RUN_IDS})`, bindings),
      {
        sql: `DELETE FROM workflow_runs WHERE ${OLD_REMOVABLE_RUN_CONDITION} RETURNING id`,
        bindings,
      },
    ]);
    const deletedRows = (results.at(-1)?.rows ?? []) as readonly { id: string }[];
    return { deletedRunIds: deletedRows.map((row) => row.id as WorkflowRunId) };
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

  // Why a delete was refused, read after the refusal: the run is still going, or there is none.
  #refusal(workflowRunId: WorkflowRunId): DaemonDomainError {
    const status = this.#readStatus.get(workflowRunId)?.status;
    if (status === undefined) {
      return new WorkflowNotFoundError({ workflowRunId });
    }
    return new DaemonDomainError(`The run is ${status}. Cancel it first.`, {
      code: WORKFLOW_RUN_NOT_DELETABLE_CODE,
      jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
      detail: { workflowRunId, status },
    });
  }
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
