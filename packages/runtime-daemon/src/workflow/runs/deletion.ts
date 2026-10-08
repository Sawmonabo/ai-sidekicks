// Deleting runs and keeping them: one run's delete, `Delete runs older than…` with the preview its
// confirm reads, and the Keep mark that bulk delete leaves. Each run's delete removes its steps,
// its form drafts, its gate answers and its execution context with the run, in the one write that
// appends the run's `workflow.run_deleted`: the session log keeps the run's earlier events, so a
// rebuild of the runs from the log needs that record to leave the run out. Each deleted run's git
// common folder is answered, so its snapshot refs can be pruned.

import type { Statement } from "better-sqlite3";

import {
  EventEnvelopeVersionSchema,
  type EventEnvelopeVersion,
} from "@ai-sidekicks/contracts/event/envelope";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/message";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { WorkflowDefinitionId } from "@ai-sidekicks/contracts/workflow/definition/document";
import type { WorkflowRunDeletedPayload } from "@ai-sidekicks/contracts/workflow/run/control";
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
import type { WriteStatement } from "../../database/statement.js";
import { WriteRefusedError } from "../../database/writer.js";
import { SessionEventAppender, type SessionEventLog } from "../../events/session/appender.js";
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

/**
 * A bulk delete whose write failed for some run: `deleted` holds every run it did delete, whose
 * snapshot refs still need pruning, and `cause` the first failure.
 *
 * @consumedBy the runs delete handler
 */
export class WorkflowRunsDeleteIncompleteError extends Error {
  readonly deleted: readonly DeletedWorkflowRun[];

  constructor(deleted: readonly DeletedWorkflowRun[], cause: unknown) {
    super(`Deleting old runs failed after ${String(deleted.length)} were deleted`, { cause });
    this.name = "WorkflowRunsDeleteIncompleteError";
    this.deleted = deleted;
  }
}

// A chain's first run holds the chain's count and its answer, which a later run still going,
// or parked on a failed step can still resume, needs, so the first run is not deleted while one is.
const LATER_CHAIN_RUN_GOING = `EXISTS (SELECT 1 FROM workflow_runs AS later
    WHERE later.chain_root_run_id = run.id AND later.id <> run.id
      AND (later.status IN (${GOING_RUN_STATUSES_SQL})
        OR (later.status = 'failed' AND later.finished_at IS NULL)))`;

const OLD_RUN = "run.started_at < @olderThan";

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

// What a run's deleted event and its answer carry, read before its write: the run's pinned
// version and session never change, nor does the git common folder its execution context names.
const SELECT_DELETED_RUN = `SELECT run.id AS run_id, run.session_id, version.definition_id,
  run.workflow_version_id, context.git_common_dir
  FROM workflow_runs AS run
  JOIN workflow_versions AS version ON version.id = run.workflow_version_id
  LEFT JOIN run_execution_contexts AS context ON context.run_id = run.id`;

const RUN_TO_DELETE_SQL = `${SELECT_DELETED_RUN} WHERE run.id = ?`;
const REMOVABLE_RUNS_SQL = `${SELECT_DELETED_RUN} WHERE ${REMOVABLE}`;

// Matches the run only while it may be deleted, so a write that starts with it refuses a run still
// going and a chain's first run while a later run is going.
const DELETABLE_RUN_SQL = `SELECT run.id FROM workflow_runs AS run
  WHERE run.id = @workflowRunId AND run.status NOT IN (${GOING_RUN_STATUSES_SQL})
    AND NOT ${LATER_CHAIN_RUN_GOING}`;
// Matches the run only while bulk delete would still remove it.
const STILL_REMOVABLE_RUN_SQL = `SELECT run.id FROM workflow_runs AS run
  WHERE run.id = @workflowRunId AND ${REMOVABLE}`;

const RUN_STATUS_SQL = "SELECT status FROM workflow_runs WHERE id = ?";

const KEEP_SQL = "UPDATE workflow_runs SET kept = ? WHERE id = ?";

// How many runs' writes a bulk delete keeps queued at once: ten of the writer's batches.
const RUNS_DELETED_AT_ONCE = 500;

// Envelope version of the run's deleted event, parsed at load so a bad literal throws at import.
const RUN_DELETED_EVENT_VERSION: EventEnvelopeVersion = EventEnvelopeVersionSchema.parse("1.0");

interface PreviewRow {
  readonly delete_count: number;
  readonly kept_count: number;
  readonly waiting_count: number;
}

interface DeletedRunRow {
  readonly run_id: string;
  readonly session_id: string;
  readonly definition_id: string;
  readonly workflow_version_id: string;
  readonly git_common_dir: string | null;
}

/**
 * The statements that remove a run with every row that hangs off it, children first so the foreign
 * keys hold at every statement: what a delete writes with the run's `workflow.run_deleted`, and
 * what a rebuild of the runs applies on reading that event.
 *
 * @consumedBy the rebuild of the runs from the session log
 */
export function workflowRunDeletionStatements(workflowRunId: WorkflowRunId): WriteStatement[] {
  const bindings = [workflowRunId];
  return [
    { sql: "DELETE FROM workflow_steps WHERE workflow_run_id = ?", bindings },
    { sql: "DELETE FROM human_phase_form_state WHERE workflow_run_id = ?", bindings },
    { sql: "DELETE FROM workflow_gate_resolutions WHERE workflow_run_id = ?", bindings },
    { sql: "DELETE FROM run_execution_contexts WHERE run_id = ?", bindings },
    { sql: "DELETE FROM workflow_runs WHERE id = ?", bindings },
  ];
}

/** Deletes runs, one or many, and sets the Keep mark that bulk delete leaves. */
export class WorkflowRunDeletion {
  readonly #writer: Pick<DatabaseConnections["writer"], "write">;
  readonly #appender: SessionEventAppender;
  readonly #readRunToDelete: Statement<[string], DeletedRunRow>;
  readonly #readRemovableRuns: Statement<[{ olderThan: string }], DeletedRunRow>;
  readonly #preview: Statement<[{ olderThan: string }], PreviewRow>;
  readonly #readStatus: Statement<[string], { status: WorkflowRunStatus }>;

  constructor(database: DatabaseConnections, sessionEvents: SessionEventLog) {
    this.#writer = database.writer;
    this.#appender = new SessionEventAppender({ sessionEvents }, RUN_DELETED_EVENT_VERSION);
    this.#readRunToDelete = database.reader.prepare(RUN_TO_DELETE_SQL);
    this.#readRemovableRuns = database.reader.prepare(REMOVABLE_RUNS_SQL);
    this.#preview = database.reader.prepare(PREVIEW_SQL);
    this.#readStatus = database.reader.prepare(RUN_STATUS_SQL);
  }

  /**
   * Deletes one run with its steps, form drafts, gate answers and execution context, and appends
   * its `workflow.run_deleted` in the same write. Refuses a `new`, `running` or `waiting` run, and
   * a chain's first run while a later run of its chain is one, with `workflow.run_not_deletable`,
   * and a run there is none of with `workflow.not_found`, writing nothing either way.
   */
  async delete(workflowRunId: WorkflowRunId): Promise<DeletedWorkflowRun> {
    const run = this.#readRunToDelete.get(workflowRunId);
    if (run === undefined) {
      throw new WorkflowNotFoundError({ workflowRunId });
    }
    try {
      return await this.#deleteRun(run, DELETABLE_RUN_SQL, {});
    } catch (error) {
      if (error instanceof WriteRefusedError) {
        throw this.#refusal(workflowRunId);
      }
      throw error;
    }
  }

  /**
   * How many runs started before `olderThan` `Delete runs older than…` would remove; how many it
   * would remove but for their Keep mark; and how many it leaves because they are waiting or parked
   * on a failed step.
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
   * Deletes every run the preview counts for deletion, each with all its rows and its own
   * `workflow.run_deleted`, and resolves with each one deleted. A run read as deletable that its
   * guard no longer matches at its write, such as one kept since, is left. Rejects with
   * {@link WorkflowRunsDeleteIncompleteError} when a run's write fails, once every other run's
   * write has settled.
   */
  async deleteOlderThan(olderThan: string): Promise<DeletedWorkflowRun[]> {
    const bindings = { olderThan: storedInstant(olderThan) };
    const runs = this.#readRemovableRuns.all(bindings);
    const outcomes: PromiseSettledResult<DeletedWorkflowRun>[] = [];
    // A slice of runs' writes is queued at once, so the writer commits them in shared batches
    // while the writes in flight stay bounded however many runs go.
    for (let start = 0; start < runs.length; start += RUNS_DELETED_AT_ONCE) {
      const slice = runs.slice(start, start + RUNS_DELETED_AT_ONCE);
      outcomes.push(
        ...(await Promise.allSettled(
          slice.map((run) => this.#deleteRun(run, STILL_REMOVABLE_RUN_SQL, bindings)),
        )),
      );
    }
    const deleted: DeletedWorkflowRun[] = [];
    let failure: unknown;
    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled") {
        deleted.push(outcome.value);
      } else if (!(outcome.reason instanceof WriteRefusedError) && failure === undefined) {
        // A refusal is a run its guard no longer matches, which bulk delete leaves.
        failure = outcome.reason;
      }
    }
    if (failure !== undefined) {
      throw new WorkflowRunsDeleteIncompleteError(deleted, failure);
    }
    return deleted;
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

  // One run's delete as one write: the guard, which refuses the write unless it matches the run,
  // bound with `guardBindings` beside the run's id; the run's rows' deletes; and its deleted event.
  async #deleteRun(
    run: DeletedRunRow,
    guardSql: string,
    guardBindings: Record<string, string>,
  ): Promise<DeletedWorkflowRun> {
    const workflowRunId = run.run_id as WorkflowRunId;
    const payload: WorkflowRunDeletedPayload = {
      sessionId: run.session_id as SessionId,
      workflowRunId,
      definitionId: run.definition_id as WorkflowDefinitionId,
      workflowVersionId: run.workflow_version_id,
    };
    await this.#appender.append("workflow.run_deleted", payload, {
      transactionalPrelude: [
        { sql: guardSql, bindings: { ...guardBindings, workflowRunId }, expectedRowCount: 1 },
        ...workflowRunDeletionStatements(workflowRunId),
      ],
    });
    return { workflowRunId, gitCommonDir: run.git_common_dir };
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
