// Reading runs: one run with its chain's first run and every step, and the runs list with its
// filters, its version scope and its paging. Each read is one statement, so it sees one committed
// state of the database.

import type { Statement } from "better-sqlite3";

import type { WorkflowDefinitionId } from "@ai-sidekicks/contracts/workflow/definition/document";
import type { WorkflowRunId } from "@ai-sidekicks/contracts/workflow/run/id";
import type { WorkflowRunListRequest } from "@ai-sidekicks/contracts/workflow/run/records";
import type { WorkflowWaitCause } from "@ai-sidekicks/contracts/workflow/run/status";

import type { DatabaseConnections } from "../../database/connections.js";
import {
  RUN_COLUMNS,
  STEP_COLUMNS,
  storedInstant,
  storedRunFromColumns,
  storedStepFromColumns,
  type RunColumns,
  type StepColumns,
  type StoredWorkflowChainRoot,
  type StoredWorkflowRun,
  type StoredWorkflowStep,
} from "./record.js";
import { WorkflowNotFoundError } from "../not-found.js";
import { InvalidCursorError } from "./invalid-cursor.js";
import { spentAccountColumns } from "./spent-account.js";

/**
 * One run as `workflow.runRead` builds on it: its row, the first run of its chain, whether it
 * recorded an execution context, and every step in execution order.
 */
export type StoredWorkflowRunRead = StoredWorkflowRun & {
  /** Absent once the chain's first run has been deleted. */
  chainRoot?: StoredWorkflowChainRoot | undefined;
  executionContextCaptured: boolean;
  steps: StoredWorkflowStep[];
};

/** A runs-list read: the filters, the version scope and the cursor, with the page's size. */
export type WorkflowRunListPageRequest = WorkflowRunListRequest & { limit: number };

/**
 * One run as the runs list reads it: its row, its workflow's name, how many steps it has, and,
 * while a step waits, what the first waiting step waits on and when an account wait resumes.
 *
 * @consumedBy the workflow run list handler
 */
export type StoredWorkflowRunListEntry = StoredWorkflowRun & {
  definitionName: string;
  stepCount: number;
  waitCause?: WorkflowWaitCause | undefined;
  resumeAt?: string | undefined;
};

/**
 * One page of the runs list, newest first, and how many runs the filters match in all. Each run
 * is listed once across pages: the order is the run's creation and then its id, neither of which
 * changes after the run is created.
 */
export interface StoredWorkflowRunListPage {
  runs: StoredWorkflowRunListEntry[];
  nextCursor?: string | undefined;
  totalCount: number;
}

type NullableColumns<Columns> = { readonly [Name in keyof Columns]: Columns[Name] | null };

interface ChainRootColumns {
  readonly root_run_id: string | null;
  readonly root_definition_id: string | null;
  readonly root_workflow_name: string | null;
  readonly root_started_at: string | null;
  readonly root_run_count: number | null;
  readonly execution_context_captured: 0 | 1;
}

type RunReadRow = RunColumns & ChainRootColumns & NullableColumns<StepColumns>;

// The run's row once per step, or once with null step columns for a run with no step yet.
const READ_RUN_SQL = `SELECT ${RUN_COLUMNS},
    root.id AS root_run_id, root_version.definition_id AS root_definition_id,
    json_extract(root_version.definition_body, '$.name') AS root_workflow_name,
    root.started_at AS root_started_at, root.chain_run_count AS root_run_count,
    EXISTS (SELECT 1 FROM run_execution_contexts AS context WHERE context.run_id = run.id)
      AS execution_context_captured,
    ${STEP_COLUMNS}, ${spentAccountColumns("account")}
  FROM workflow_runs AS run
  JOIN workflow_versions AS version ON version.id = run.workflow_version_id
  LEFT JOIN workflow_runs AS root
    ON root.id = run.chain_root_run_id AND root.chain_run_count IS NOT NULL
  LEFT JOIN workflow_versions AS root_version ON root_version.id = root.workflow_version_id
  LEFT JOIN workflow_steps AS step ON step.workflow_run_id = run.id
  LEFT JOIN provider_accounts AS account ON account.account_id = step.wait_account_id
  WHERE run.id = ?
  ORDER BY step.execution_index`;

interface ListBindings {
  readonly sessionId: string | null;
  readonly statusesJson: string | null;
  readonly triggerKindsJson: string | null;
  readonly startedAfter: string | null;
  readonly startedBefore: string | null;
  readonly definitionId: string | null;
  readonly workflowVersionId: string | null;
  readonly afterCreatedAt: string | null;
  readonly afterRunId: string | null;
  readonly pageRowLimit: number;
}

interface ListEntryColumns extends RunColumns {
  readonly definition_name: string;
  readonly waiting_cause: WorkflowWaitCause | null;
  readonly waiting_resume_at: string | null;
}

type ListRow = NullableColumns<ListEntryColumns> & {
  readonly total_count: number;
  readonly step_count: number;
};

// One statement answers the page and the total, so the two always describe the same runs; the
// anchor row keeps the total when the page is empty. The page reads one row past its size to
// learn whether another follows.
const LIST_RUNS_SQL = `WITH matched AS (
    SELECT ${RUN_COLUMNS}, json_extract(version.definition_body, '$.name') AS definition_name
    FROM workflow_runs AS run
    JOIN workflow_versions AS version ON version.id = run.workflow_version_id
    WHERE (@sessionId IS NULL OR run.session_id = @sessionId)
      AND (@statusesJson IS NULL
           OR run.status IN (SELECT value FROM json_each(@statusesJson)))
      AND (@triggerKindsJson IS NULL
           OR json_extract(run.trigger_json, '$.kind')
              IN (SELECT value FROM json_each(@triggerKindsJson)))
      AND (@startedAfter IS NULL OR run.started_at >= @startedAfter)
      AND (@startedBefore IS NULL OR run.started_at < @startedBefore)
      AND (@definitionId IS NULL OR version.definition_id = @definitionId)
      AND (@workflowVersionId IS NULL OR run.workflow_version_id = @workflowVersionId)
  ),
  page AS (
    SELECT * FROM matched
    WHERE @afterCreatedAt IS NULL
       OR created_at < @afterCreatedAt
       OR (created_at = @afterCreatedAt AND run_id < @afterRunId)
    ORDER BY created_at DESC, run_id DESC
    LIMIT @pageRowLimit
  )
  SELECT (SELECT COUNT(*) FROM matched) AS total_count, page.*,
    (SELECT COUNT(*) FROM workflow_steps AS step WHERE step.workflow_run_id = page.run_id)
      AS step_count,
    waiting.wait_cause AS waiting_cause, waiting.resume_at AS waiting_resume_at
  FROM (SELECT 1) AS anchor
  LEFT JOIN page ON TRUE
  LEFT JOIN workflow_steps AS waiting
    ON waiting.workflow_run_id = page.run_id
   AND waiting.execution_index = (
     SELECT MIN(first_waiting.execution_index) FROM workflow_steps AS first_waiting
     WHERE first_waiting.workflow_run_id = page.run_id AND first_waiting.status = 'waiting'
   )
  ORDER BY page.created_at DESC, page.run_id DESC`;

// A cursor names the last run a page listed by its creation instant, as `toISOString` writes it,
// and its id.
const LIST_CURSOR_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)_([0-9a-f-]{36})$/u;

/** Reads runs and their steps for the run page and the runs list. */
export class WorkflowRunStore {
  readonly #readRun: Statement<[string], RunReadRow>;
  readonly #listRuns: Statement<[ListBindings], ListRow>;

  constructor(database: Pick<DatabaseConnections, "reader">) {
    this.#readRun = database.reader.prepare(READ_RUN_SQL);
    this.#listRuns = database.reader.prepare(LIST_RUNS_SQL);
  }

  /** The run `workflowRunId` names; throws `workflow.not_found` when there is none. */
  read(workflowRunId: WorkflowRunId): StoredWorkflowRunRead {
    const rows = this.#readRun.all(workflowRunId);
    const [first] = rows;
    if (first === undefined) {
      throw new WorkflowNotFoundError({ workflowRunId });
    }
    const steps: StoredWorkflowStep[] = [];
    for (const row of rows) {
      if (row.step_execution_index !== null) {
        // A step row's own columns are never null where its key is present.
        steps.push(storedStepFromColumns(workflowRunId, row as RunReadRow & StepColumns));
      }
    }
    return {
      ...storedRunFromColumns(first),
      chainRoot: chainRootFromColumns(first),
      executionContextCaptured: first.execution_context_captured === 1,
      steps,
    };
  }

  /**
   * One page of the runs the request's filters match, newest first, after the run its cursor
   * names. Throws {@link InvalidCursorError} when the cursor is not one this store wrote.
   */
  list(request: WorkflowRunListPageRequest): StoredWorkflowRunListPage {
    const after = request.cursor === undefined ? undefined : readListCursor(request.cursor);
    const rows = this.#listRuns.all({
      sessionId: request.sessionId ?? null,
      statusesJson: request.status === undefined ? null : JSON.stringify(request.status),
      triggerKindsJson:
        request.triggerKind === undefined ? null : JSON.stringify(request.triggerKind),
      startedAfter: request.startedAfter === undefined ? null : storedInstant(request.startedAfter),
      startedBefore:
        request.startedBefore === undefined ? null : storedInstant(request.startedBefore),
      definitionId: request.definitionId ?? null,
      workflowVersionId: request.workflowVersionId ?? null,
      afterCreatedAt: after?.createdAt ?? null,
      afterRunId: after?.workflowRunId ?? null,
      pageRowLimit: request.limit + 1,
    });
    const totalCount = rows[0]?.total_count ?? 0;
    const pageRows = rows.filter((row): row is ListRow & ListEntryColumns => row.run_id !== null);
    const runs = pageRows.slice(0, request.limit).map((row) => ({
      ...storedRunFromColumns(row),
      definitionName: row.definition_name,
      stepCount: row.step_count,
      waitCause: row.waiting_cause ?? undefined,
      resumeAt: row.waiting_resume_at ?? undefined,
    }));
    const last = pageRows.length > request.limit ? pageRows[request.limit - 1] : undefined;
    return {
      runs,
      nextCursor: last === undefined ? undefined : `${last.created_at}_${last.run_id}`,
      totalCount,
    };
  }
}

function chainRootFromColumns(columns: ChainRootColumns): StoredWorkflowChainRoot | undefined {
  if (
    columns.root_run_id === null ||
    columns.root_definition_id === null ||
    columns.root_workflow_name === null ||
    columns.root_run_count === null
  ) {
    return undefined;
  }
  return {
    runId: columns.root_run_id as WorkflowRunId,
    definitionId: columns.root_definition_id as WorkflowDefinitionId,
    workflowName: columns.root_workflow_name,
    startedAt: columns.root_started_at ?? undefined,
    runCount: columns.root_run_count,
  };
}

function readListCursor(cursor: string): { createdAt: string; workflowRunId: string } {
  const match = LIST_CURSOR_PATTERN.exec(cursor);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new InvalidCursorError(`"${cursor}" is not a runs-list cursor`);
  }
  return { createdAt: match[1], workflowRunId: match[2] };
}
