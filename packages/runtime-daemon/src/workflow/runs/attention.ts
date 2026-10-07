// The runs-needing-you section: every run waiting on a person, oldest first, with the runs parked
// on a spent provider account folded into one line per account above them. No runs-table filter
// narrows it.

import type { Statement } from "better-sqlite3";

import type { WorkflowRunId } from "@ai-sidekicks/contracts/workflow/run/id";
import type {
  WorkflowRunAttentionEntry,
  WorkflowRunAttentionListResponse,
} from "@ai-sidekicks/contracts/workflow/run/records";
import type { WorkflowWaitCause } from "@ai-sidekicks/contracts/workflow/run/status";

import type { DatabaseConnections } from "../../database/connections.js";
import {
  spentAccountColumns,
  spentAccountFromColumns,
  type SpentAccountColumns,
} from "./spent-account.js";

interface PersonWaitRow {
  readonly run_id: string;
  readonly wait_cause: Exclude<WorkflowWaitCause, "account">;
  readonly waiting_since: string;
  readonly workflow_name: string;
  readonly step_name: string | null;
}

interface AccountWaitRow extends SpentAccountColumns {
  readonly wait_account_id: string;
  readonly affected_run_count: number;
  readonly waiting_since: string;
  readonly resume_at: string | null;
}

// Waiting steps are read only in going runs, the set the runs table's partial status index holds.
// A run with several steps waiting on a person is one line, named by the step that waits longest.
const PERSON_WAITS_SQL = `SELECT run_id, wait_cause, waiting_since, workflow_name, step_name
  FROM (
    SELECT step.workflow_run_id AS run_id, step.wait_cause, step.started_at AS waiting_since,
      json_extract(version.definition_body, '$.name') AS workflow_name,
      (SELECT json_extract(node.value, '$.name')
         FROM json_each(version.definition_body, '$.nodes') AS node
        WHERE json_extract(node.value, '$.id') = step.node_id) AS step_name,
      ROW_NUMBER() OVER (
        PARTITION BY step.workflow_run_id ORDER BY step.started_at, step.execution_index
      ) AS place_in_run
    FROM workflow_runs AS run
    JOIN workflow_versions AS version ON version.id = run.workflow_version_id
    JOIN workflow_steps AS step ON step.workflow_run_id = run.id
    WHERE run.status IN ('new', 'running', 'waiting')
      AND step.status = 'waiting' AND step.wait_cause <> 'account'
  )
  WHERE place_in_run = 1
  ORDER BY waiting_since, run_id`;

// The earliest armed resume instant stands for the account: the first of its runs to go on.
const ACCOUNT_WAITS_SQL = `SELECT step.wait_account_id,
    COUNT(DISTINCT step.workflow_run_id) AS affected_run_count,
    MIN(step.started_at) AS waiting_since, MIN(step.resume_at) AS resume_at,
    ${spentAccountColumns("account")}
  FROM workflow_runs AS run
  JOIN workflow_steps AS step ON step.workflow_run_id = run.id
  LEFT JOIN provider_accounts AS account ON account.account_id = step.wait_account_id
  WHERE run.status IN ('new', 'running', 'waiting')
    AND step.status = 'waiting' AND step.wait_cause = 'account'
  GROUP BY step.wait_account_id
  ORDER BY waiting_since, step.wait_account_id`;

/** Reads the runs-needing-you section that the Runs tab and `Next waiting` walk. */
export class WorkflowRunAttentionList {
  readonly #readPersonWaits: Statement<[], PersonWaitRow>;
  readonly #readAccountWaits: Statement<[], AccountWaitRow>;

  constructor(database: Pick<DatabaseConnections, "reader">) {
    this.#readPersonWaits = database.reader.prepare(PERSON_WAITS_SQL);
    this.#readAccountWaits = database.reader.prepare(ACCOUNT_WAITS_SQL);
  }

  /**
   * The account lines, oldest first, then one line per run waiting on a person, oldest first.
   * Throws when a waiting step's node is missing from its run's version, or its spent account
   * from the accounts, since neither line can be shown without it.
   */
  read(): WorkflowRunAttentionListResponse {
    const accountEntries: WorkflowRunAttentionEntry[] = this.#readAccountWaits.all().map((row) => ({
      kind: "account",
      account: spentAccountFromColumns(row.wait_account_id, row),
      affectedRunCount: row.affected_run_count,
      waitingSince: row.waiting_since,
      resumeAt: row.resume_at ?? undefined,
    }));
    const runEntries: WorkflowRunAttentionEntry[] = this.#readPersonWaits.all().map((row) => {
      if (row.step_name === null) {
        throw new Error(`A waiting step of run ${row.run_id} names no node of its version`);
      }
      return {
        kind: "run",
        workflowRunId: row.run_id as WorkflowRunId,
        workflowName: row.workflow_name,
        waitCause: row.wait_cause,
        waitingStepName: row.step_name,
        waitingSince: row.waiting_since,
      };
    });
    return {
      entries: [...accountEntries, ...runEntries],
      waitingOnPersonCount: runEntries.length,
    };
  }
}
