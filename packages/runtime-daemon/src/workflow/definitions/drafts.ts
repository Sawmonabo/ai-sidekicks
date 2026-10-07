// The builder's unsaved drafts, one per saved workflow and one for a new workflow, so a draft
// survives a reload of the window. Saving a version clears its workflow's draft in the same write.
import type { Statement } from "better-sqlite3";

import type {
  WorkflowDraftReadResponse,
  WorkflowDraftUpdateRequest,
  WorkflowDraftUpdateResponse,
} from "@ai-sidekicks/contracts/workflow/definition/builder";
import type {
  WorkflowDefinitionId,
  WorkflowDraftDocument,
} from "@ai-sidekicks/contracts/workflow/definition/document";

import type { DatabaseConnections } from "../../database/connections.js";
import type { WriteStatement } from "../../database/statement.js";
import { WriteRefusedError, type DatabaseWriter } from "../../database/writer.js";
import { WorkflowNotFoundError } from "./errors.js";

// The key of the new workflow's draft, which names no definition.
const NEW_WORKFLOW_DRAFT_KEY = "";

// Returns one row only while the workflow is in the library, so a draft never outlives it.
const LIVE_DEFINITION_SQL =
  "SELECT 1 FROM workflow_definitions WHERE id = ? AND deleted_at IS NULL";
const UPSERT_DRAFT_SQL = `INSERT INTO workflow_drafts
    (definition_id, based_on_version_number, document_json, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT (definition_id) DO UPDATE SET
    based_on_version_number = excluded.based_on_version_number,
    document_json = excluded.document_json,
    updated_at = excluded.updated_at`;
const DELETE_DRAFT_SQL = "DELETE FROM workflow_drafts WHERE definition_id = ?";

interface DraftRow {
  readonly based_on_version_number: number | null;
  readonly document_json: string;
  readonly updated_at: string;
}

/**
 * The statement that clears a saved workflow's draft, or with no id the new workflow's, for a save
 * or a delete to run inside its own write.
 */
export function clearWorkflowDraftStatement(definitionId?: WorkflowDefinitionId): WriteStatement {
  return { sql: DELETE_DRAFT_SQL, bindings: [definitionId ?? NEW_WORKFLOW_DRAFT_KEY] };
}

/**
 * Holds the builder's drafts in `workflow_drafts`. Each update replaces the draft it names whole,
 * so the last write wins and a retried update needs no key.
 */
export class WorkflowDraftStore {
  readonly #writer: Pick<DatabaseWriter, "write">;
  readonly #now: () => Date;
  readonly #selectDraft: Statement<[string], DraftRow>;

  constructor(database: DatabaseConnections, now: () => Date = () => new Date()) {
    this.#writer = database.writer;
    this.#now = now;
    this.#selectDraft = database.reader.prepare(
      `SELECT based_on_version_number, document_json, updated_at
       FROM workflow_drafts WHERE definition_id = ?`,
    );
  }

  /**
   * The draft of the named workflow, or of the new workflow with no id; `draft` is null when none
   * is held.
   */
  read(definitionId?: WorkflowDefinitionId): WorkflowDraftReadResponse {
    const row = this.#selectDraft.get(definitionId ?? NEW_WORKFLOW_DRAFT_KEY);
    if (row === undefined) {
      return { draft: null };
    }
    const document = JSON.parse(row.document_json) as WorkflowDraftDocument;
    if (definitionId === undefined) {
      return { draft: { document, updatedAt: row.updated_at } };
    }
    return {
      draft:
        row.based_on_version_number === null
          ? { definitionId, document, updatedAt: row.updated_at }
          : {
              definitionId,
              basedOnVersionNumber: row.based_on_version_number,
              document,
              updatedAt: row.updated_at,
            },
    };
  }

  /**
   * Replaces the draft the request names and resolves with when it was stored. Rejects with
   * {@link WorkflowNotFoundError} for a saved workflow that is not in the library.
   */
  async update(request: WorkflowDraftUpdateRequest): Promise<WorkflowDraftUpdateResponse> {
    const updatedAt = this.#now().toISOString();
    const documentJson = JSON.stringify(request.document);
    const { definitionId } = request;
    if (definitionId === undefined) {
      await this.#writer.write([
        {
          sql: UPSERT_DRAFT_SQL,
          bindings: [NEW_WORKFLOW_DRAFT_KEY, null, documentJson, updatedAt],
        },
      ]);
      return { updatedAt };
    }
    // The library check and the upsert are one write, so a delete cannot land between them.
    try {
      await this.#writer.write([
        { sql: LIVE_DEFINITION_SQL, bindings: [definitionId], expectedRowCount: 1 },
        {
          sql: UPSERT_DRAFT_SQL,
          bindings: [definitionId, request.basedOnVersionNumber ?? null, documentJson, updatedAt],
        },
      ]);
    } catch (error) {
      if (error instanceof WriteRefusedError) {
        throw new WorkflowNotFoundError({ definitionId });
      }
      throw error;
    }
    return { updatedAt };
  }
}
