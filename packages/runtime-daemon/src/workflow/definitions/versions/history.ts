// Reads of a workflow's saved versions, which never change: one version, the whole chain a
// version belongs to, and the structural difference between two versions.
import type { Statement } from "better-sqlite3";

import type { AgentId } from "@ai-sidekicks/contracts/agent/definition";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/message";
import type {
  WorkflowDefinitionId,
  WorkflowDocumentHashedBody,
} from "@ai-sidekicks/contracts/workflow/definition/document";
import type {
  WorkflowVersionChainEntry,
  WorkflowVersionChainReadRequest,
  WorkflowVersionChainReadResponse,
  WorkflowVersionDiffReadRequest,
  WorkflowVersionDiffReadResponse,
  WorkflowVersionReadRequest,
  WorkflowVersionReadResponse,
} from "@ai-sidekicks/contracts/workflow/definition/methods";

import type { DatabaseConnections } from "../../../database/connections.js";
import { DaemonDomainError } from "../../../ipc/domain-error.js";
import type { RegistryDispatchCode } from "../../../ipc/registry.js";
import { WorkflowNotFoundError } from "../../not-found.js";
import { parseStoredWorkflowBody, readStoredWorkflowDocument } from "../stored-document.js";
import { countWorkflowChanges, diffWorkflowBodies } from "./difference.js";

const VERSION_COLUMNS = `id, definition_id, version_number, content_hash, schema_version,
  definition_body, layout_json, created_at, saved_by_agent_id`;

interface VersionRow {
  readonly id: string;
  readonly definition_id: string;
  readonly version_number: number;
  readonly content_hash: string;
  readonly schema_version: string;
  readonly definition_body: string;
  readonly layout_json: string | null;
  readonly created_at: string;
  readonly saved_by_agent_id: string | null;
}

/** Reads a workflow's saved versions, a deleted workflow's included, since runs pin them. */
export class WorkflowVersions {
  readonly #selectByNumber: Statement<[string, number], VersionRow>;
  readonly #selectById: Statement<[string], VersionRow>;
  readonly #selectChain: Statement<[string], VersionRow>;

  constructor(database: DatabaseConnections) {
    this.#selectByNumber = database.reader.prepare(
      `SELECT ${VERSION_COLUMNS} FROM workflow_versions
       WHERE definition_id = ? AND version_number = ?`,
    );
    this.#selectById = database.reader.prepare(
      `SELECT ${VERSION_COLUMNS} FROM workflow_versions WHERE id = ?`,
    );
    this.#selectChain = database.reader.prepare(
      `SELECT ${VERSION_COLUMNS} FROM workflow_versions
       WHERE definition_id = (SELECT definition_id FROM workflow_versions WHERE id = ?)
       ORDER BY version_number`,
    );
  }

  /**
   * One version's document, with the layout it was saved with. Throws
   * {@link WorkflowNotFoundError} when the workflow has no such version.
   */
  read(request: WorkflowVersionReadRequest): WorkflowVersionReadResponse {
    const { definitionId, versionNumber } = request;
    const row = this.#selectByNumber.get(definitionId, versionNumber);
    if (row === undefined) {
      throw new WorkflowNotFoundError({ definitionId, versionNumber });
    }
    return {
      definitionId,
      versionNumber: row.version_number,
      workflowVersionId: row.id,
      contentHash: row.content_hash,
      document: readStoredWorkflowDocument({
        schemaVersion: row.schema_version,
        definitionBody: row.definition_body,
        layoutJson: row.layout_json,
      }),
      createdAt: row.created_at,
    };
  }

  /**
   * Every version of the workflow the given version belongs to, oldest first, each with who saved
   * it and what it changed over the one before. Throws {@link WorkflowNotFoundError} for an
   * unknown version.
   */
  readChain(request: WorkflowVersionChainReadRequest): WorkflowVersionChainReadResponse {
    const rows = this.#selectChain.all(request.workflowVersionId);
    const [firstRow] = rows;
    if (firstRow === undefined) {
      throw new WorkflowNotFoundError({ workflowVersionId: request.workflowVersionId });
    }
    let previousBody: WorkflowDocumentHashedBody | undefined;
    const versions = rows.map((row): WorkflowVersionChainEntry => {
      const body = parseStoredWorkflowBody(row.definition_body);
      const entry: WorkflowVersionChainEntry = {
        workflowVersionId: row.id,
        versionNumber: row.version_number,
        contentHash: row.content_hash,
        createdAt: row.created_at,
        savedBy:
          row.saved_by_agent_id === null
            ? { kind: "user" }
            : { kind: "agent", agentId: row.saved_by_agent_id as AgentId },
      };
      if (previousBody !== undefined) {
        entry.changesFromPrevious = countWorkflowChanges(diffWorkflowBodies(previousBody, body));
      }
      previousBody = body;
      return entry;
    });
    return { definitionId: firstRow.definition_id as WorkflowDefinitionId, versions };
  }

  /**
   * The structural difference from one version to another over the hashed body alone. Throws
   * {@link WorkflowNotFoundError} for an unknown version, and an `invalid_params` refusal for two
   * versions of different workflows.
   */
  readDiff(request: WorkflowVersionDiffReadRequest): WorkflowVersionDiffReadResponse {
    const { fromWorkflowVersionId, toWorkflowVersionId } = request;
    const fromRow = this.#readVersion(fromWorkflowVersionId);
    const toRow = this.#readVersion(toWorkflowVersionId);
    if (fromRow.definition_id !== toRow.definition_id) {
      throw new DaemonDomainError("The two versions belong to different workflows.", {
        code: "invalid_params" satisfies RegistryDispatchCode,
        jsonRpcCode: JsonRpcErrorCode.InvalidParams,
        detail: { fromWorkflowVersionId, toWorkflowVersionId },
      });
    }
    return diffWorkflowBodies(
      parseStoredWorkflowBody(fromRow.definition_body),
      parseStoredWorkflowBody(toRow.definition_body),
    );
  }

  #readVersion(workflowVersionId: string): VersionRow {
    const row = this.#selectById.get(workflowVersionId);
    if (row === undefined) {
      throw new WorkflowNotFoundError({ workflowVersionId });
    }
    return row;
  }
}
