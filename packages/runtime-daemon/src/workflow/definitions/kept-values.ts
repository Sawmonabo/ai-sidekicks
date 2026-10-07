// The values a `Keep for later runs` step keeps for its workflow, one per name, which later runs
// read as `$vars`. They belong to the workflow, not to a version, and sit in `workflow_node_state`
// under the empty node id.
import type { Statement } from "better-sqlite3";

import type { WorkflowDefinitionId } from "@ai-sidekicks/contracts/workflow/definition/document";
import type { WorkflowRunId } from "@ai-sidekicks/contracts/workflow/run/id";
import type { WorkflowKeptVarsClearResponse } from "@ai-sidekicks/contracts/workflow/run/records";

import type { DatabaseConnections } from "../../database/connections.js";
import type { WriteStatement } from "../../database/statement.js";
import { WriteRefusedError, type DatabaseWriter } from "../../database/writer.js";
import { WorkflowNotFoundError } from "./errors.js";

// Returns one row for any workflow ever created, deleted or not.
const DEFINITION_EXISTS_SQL = "SELECT 1 FROM workflow_definitions WHERE id = ?";
// A kept value replaces the one its name held, whichever run kept that.
const UPSERT_KEPT_VALUE_SQL = `INSERT INTO workflow_node_state
    (definition_id, node_id, key, value_json, kept_by_run_id, updated_at)
  VALUES (?, '', ?, ?, ?, ?)
  ON CONFLICT (definition_id, node_id, key) DO UPDATE SET
    value_json = excluded.value_json,
    kept_by_run_id = excluded.kept_by_run_id,
    updated_at = excluded.updated_at`;
const DELETE_KEPT_VALUES_SQL =
  "DELETE FROM workflow_node_state WHERE definition_id = ? AND node_id = ''";

/**
 * One value a workflow keeps: its name, the value, the run that kept it and when.
 *
 * @consumedBy the step executor, which reads kept values as the run's variables
 */
export interface WorkflowKeptValue {
  readonly name: string;
  readonly value: unknown;
  readonly keptByRunId: WorkflowRunId;
  readonly keptAt: string;
}

interface KeptValueRow {
  readonly key: string;
  readonly value_json: string;
  readonly kept_by_run_id: string;
  readonly updated_at: string;
}

/** The statement that deletes every value a workflow keeps, for a delete to run in its write. */
export function clearKeptValuesStatement(definitionId: WorkflowDefinitionId): WriteStatement {
  return { sql: DELETE_KEPT_VALUES_SQL, bindings: [definitionId] };
}

/**
 * Keeps, reads and clears a workflow's kept values. A value is stored as the JSON it is given,
 * whatever its size.
 *
 * @consumedBy the step executor's Keep for later runs and the kept values clear handler
 */
export class WorkflowKeptValueStore {
  readonly #writer: Pick<DatabaseWriter, "write">;
  readonly #now: () => Date;
  readonly #selectKeptValues: Statement<[string], KeptValueRow>;

  constructor(database: DatabaseConnections, now: () => Date = () => new Date()) {
    this.#writer = database.writer;
    this.#now = now;
    this.#selectKeptValues = database.reader.prepare(
      `SELECT key, value_json, kept_by_run_id, updated_at FROM workflow_node_state
       WHERE definition_id = ? AND node_id = '' ORDER BY key`,
    );
  }

  /** Every value the workflow keeps, by name. */
  read(definitionId: WorkflowDefinitionId): WorkflowKeptValue[] {
    return this.#selectKeptValues.all(definitionId).map((row) => ({
      name: row.key,
      value: JSON.parse(row.value_json) as unknown,
      keptByRunId: row.kept_by_run_id as WorkflowRunId,
      keptAt: row.updated_at,
    }));
  }

  /**
   * Keeps each named value for the workflow from one run, in one write, each replacing the value
   * its name held; resolves with when they were kept. Each value must be JSON-serializable.
   */
  async keep(
    definitionId: WorkflowDefinitionId,
    runId: WorkflowRunId,
    values: Readonly<Record<string, unknown>>,
  ): Promise<string> {
    const keptAt = this.#now().toISOString();
    await this.#writer.write(
      Object.entries(values).map(([name, value]) => ({
        sql: UPSERT_KEPT_VALUE_SQL,
        bindings: [definitionId, name, JSON.stringify(value), runId, keptAt],
      })),
    );
    return keptAt;
  }

  /**
   * Deletes every value the workflow keeps and counts them. Rejects with
   * {@link WorkflowNotFoundError} for a workflow never created.
   */
  async clear(definitionId: WorkflowDefinitionId): Promise<WorkflowKeptVarsClearResponse> {
    let deletion;
    try {
      [, deletion] = await this.#writer.write([
        { sql: DEFINITION_EXISTS_SQL, bindings: [definitionId], expectedRowCount: 1 },
        clearKeptValuesStatement(definitionId),
      ]);
    } catch (error) {
      if (error instanceof WriteRefusedError) {
        throw new WorkflowNotFoundError({ definitionId });
      }
      throw error;
    }
    return { definitionId, clearedCount: deletion?.rowCount ?? 0 };
  }
}
