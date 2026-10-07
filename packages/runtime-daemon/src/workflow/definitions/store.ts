// The writes to the one workflow library: create, duplicate, save a new version, soft delete, and
// the settings kept beside a version (layout, pinned data, tags, permission level), which mint
// none. Each change is one write, so a refused write leaves nothing behind.
import type { Statement } from "better-sqlite3";

import type { AgentId } from "@ai-sidekicks/contracts/agent/definition";
import { foldName } from "@ai-sidekicks/contracts/name-fold";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";
import type {
  WorkflowDefinitionSettingResponse,
  WorkflowLayoutSetRequest,
  WorkflowPermissionLevelUpdateRequest,
  WorkflowPermissionLevelUpdateResponse,
  WorkflowPinDataSetRequest,
  WorkflowPinDataSetResponse,
  WorkflowTagsSetRequest,
} from "@ai-sidekicks/contracts/workflow/definition/builder";
import type {
  WorkflowDefinitionId,
  WorkflowDocument,
} from "@ai-sidekicks/contracts/workflow/definition/document";
import type {
  WorkflowDefinitionCreateRequest,
  WorkflowDefinitionCreateResponse,
  WorkflowDefinitionDeleteResponse,
  WorkflowDefinitionUpdateRequest,
  WorkflowDefinitionUpdateResponse,
} from "@ai-sidekicks/contracts/workflow/definition/methods";
import {
  checkWorkflowGraph,
  type WorkflowDefinitionFinding,
  type WorkflowNodeHandlesResolver,
} from "@ai-sidekicks/contracts/workflow/definition/refusals";

import type { DatabaseConnections } from "../../database/connections.js";
import type { WriteStatement } from "../../database/statement.js";
import { WriteRefusedError, type DatabaseWriter } from "../../database/writer.js";
import { mintUuidV7 } from "../../uuid-v7.js";
import { hashWorkflowDocument } from "./content-hash.js";
import { clearWorkflowDraftStatement } from "./drafts.js";
import { WorkflowNotFoundError } from "../not-found.js";
import { WorkflowDefinitionRefusedError, WorkflowVersionStaleError } from "./errors.js";
import { clearKeptValuesStatement } from "./kept-values.js";
import { nameHolderStatement, type WorkflowLibrary } from "./library.js";

// A permission level is left to the column's default, so a new workflow starts at `yolo`.
const INSERT_DEFINITION_SQL = `INSERT INTO workflow_definitions (
    id, name, name_folded, content_hash, schema_version, definition_body, layout_json,
    pin_data_json, tags, created_at, created_by, updated_at
  ) VALUES (
    @id, @name, @name_folded, @content_hash, @schema_version, @definition_body, @layout_json,
    @pin_data_json, @tags, @created_at, @created_by, @created_at
  )`;
const INSERT_FIRST_VERSION_SQL = `INSERT INTO workflow_versions (
    id, definition_id, version_number, content_hash, definition_body, layout_json, created_at,
    created_by, saved_by_agent_id
  ) VALUES (
    @id, @definition_id, 1, @content_hash, @definition_body, @layout_json, @created_at,
    @created_by, @saved_by_agent_id
  )`;
// Matches only while the expected version is still the latest, so the staleness check and the
// save are one write and no second save can slip a version in between.
const UPDATE_CURRENT_BODY_SQL = `UPDATE workflow_definitions SET
    name = @name, name_folded = @name_folded, content_hash = @content_hash,
    schema_version = @schema_version, definition_body = @definition_body,
    updated_at = @updated_at
  WHERE id = @id AND deleted_at IS NULL
    AND (SELECT MAX(version_number) FROM workflow_versions WHERE definition_id = @id)
      = @expected_version_number`;
const INSERT_NEXT_VERSION_SQL = `INSERT INTO workflow_versions (
    id, definition_id, version_number, parent_version_id, parent_content_hash, content_hash,
    definition_body, layout_json, created_at, created_by, saved_by_agent_id
  )
  SELECT @id, definition_id, version_number + 1, id, content_hash, @content_hash,
    @definition_body, @layout_json, @created_at, @created_by, @saved_by_agent_id
  FROM workflow_versions
  WHERE definition_id = @definition_id AND version_number = @expected_version_number`;
const LATEST_VERSION_SQL = `SELECT deleted_at,
    (SELECT MAX(version_number) FROM workflow_versions WHERE definition_id = @id)
      AS latest_version_number
  FROM workflow_definitions WHERE id = @id`;

const SOFT_DELETE_SQL =
  "UPDATE workflow_definitions SET deleted_at = @at, updated_at = @at WHERE id = @id AND deleted_at IS NULL";
// A deleted workflow arms nothing; a trigger with no schedule armed has no next fire.
const DISARM_TRIGGERS_SQL =
  "UPDATE workflow_triggers SET enabled = 0, next_fire_at = NULL WHERE definition_id = ?";
const COUNT_PINNED_RUNS_SQL = `SELECT COUNT(*) AS run_count FROM workflow_runs
  WHERE workflow_version_id IN (SELECT id FROM workflow_versions WHERE definition_id = ?)`;

const SET_LAYOUT_SQL =
  "UPDATE workflow_definitions SET layout_json = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL";
const SET_TAGS_SQL =
  "UPDATE workflow_definitions SET tags = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL";
const SET_PERMISSION_LEVEL_SQL =
  "UPDATE workflow_definitions SET permission_level = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL";
// A merge patch sets the node's items, or removes the node at a JSON null, in one statement, so a
// concurrent pin onto another node is never lost; an empty map is stored as nothing pinned.
const SET_PIN_DATA_SQL = `UPDATE workflow_definitions SET pin_data_json = NULLIF(
    json_patch(COALESCE(pin_data_json, '{}'), json_object(?, json(?))), '{}'
  ), updated_at = ?
  WHERE id = ? AND deleted_at IS NULL`;

// The position of the name check among a save's statements.
const NAME_CHECK_INDEX = 0;
const NAME_TAKEN_FINDING: WorkflowDefinitionFinding = { rule: "name_taken", nodeIds: [] };

/** Who saved a version: the device the save came from, and the agent that saved it, if one did. */
export interface WorkflowSaveAuthor {
  readonly deviceId: DeviceId;
  readonly agentId?: AgentId | undefined;
}

/** What a create does beside writing the workflow. */
export interface WorkflowCreateOptions {
  /** True when the builder saves the new workflow's draft, which the save then clears. */
  readonly savesNewWorkflowDraft: boolean;
}

interface LatestVersionRow {
  readonly deleted_at: string | null;
  readonly latest_version_number: number | null;
}

/**
 * Writes the workflow library. A save is checked in the daemon before anything is written: every
 * graph finding and a name another workflow holds, compared by case fold, refuse it whole.
 */
export class WorkflowDefinitionStore {
  readonly #writer: Pick<DatabaseWriter, "write">;
  readonly #library: WorkflowLibrary;
  readonly #resolveNodeHandles: WorkflowNodeHandlesResolver;
  readonly #now: () => Date;
  readonly #selectLatestVersion: Statement<[{ id: string }], LatestVersionRow>;

  constructor(
    database: DatabaseConnections,
    library: WorkflowLibrary,
    resolveNodeHandles: WorkflowNodeHandlesResolver,
    now: () => Date = () => new Date(),
  ) {
    this.#writer = database.writer;
    this.#library = library;
    this.#resolveNodeHandles = resolveNodeHandles;
    this.#now = now;
    this.#selectLatestVersion = database.reader.prepare(LATEST_VERSION_SQL);
  }

  /**
   * Creates a workflow and its first version in one write, with no policy check. Rejects with
   * {@link WorkflowDefinitionRefusedError} for a document with findings or a name another
   * workflow holds, writing nothing.
   */
  async create(
    request: WorkflowDefinitionCreateRequest,
    author: WorkflowSaveAuthor,
    options: WorkflowCreateOptions,
  ): Promise<WorkflowDefinitionCreateResponse> {
    const { document } = request;
    this.#refuseFindings(document);
    const { canonicalBody, contentHash } = hashWorkflowDocument(document);
    const definitionId = mintUuidV7() as WorkflowDefinitionId;
    const workflowVersionId = mintUuidV7();
    const createdAt = this.#now().toISOString();
    const layoutJson = document.layout === undefined ? null : JSON.stringify(document.layout);
    const statements: WriteStatement[] = [
      nameHolderStatement(foldName(document.name)),
      {
        sql: INSERT_DEFINITION_SQL,
        bindings: {
          id: definitionId,
          name: document.name,
          name_folded: foldName(document.name),
          content_hash: contentHash,
          schema_version: document.schemaVersion,
          definition_body: canonicalBody,
          layout_json: layoutJson,
          pin_data_json: document.pinData === undefined ? null : JSON.stringify(document.pinData),
          tags: JSON.stringify(document.tags ?? []),
          created_at: createdAt,
          created_by: author.deviceId,
        },
      },
      {
        sql: INSERT_FIRST_VERSION_SQL,
        bindings: {
          id: workflowVersionId,
          definition_id: definitionId,
          content_hash: contentHash,
          definition_body: canonicalBody,
          layout_json: layoutJson,
          created_at: createdAt,
          created_by: author.deviceId,
          saved_by_agent_id: author.agentId ?? null,
        },
      },
    ];
    if (options.savesNewWorkflowDraft) {
      statements.push(clearWorkflowDraftStatement());
    }
    try {
      await this.#writer.write(statements);
    } catch (error) {
      throw error instanceof WriteRefusedError
        ? new WorkflowDefinitionRefusedError([NAME_TAKEN_FINDING])
        : error;
    }
    return { definitionId, versionNumber: 1, contentHash, workflowVersionId, createdAt };
  }

  /**
   * Creates a copy of a workflow's latest document under the first free `<name> copy` name. The
   * copy starts with no kept values and leaves every draft alone. Rejects as {@link create} does,
   * and with {@link WorkflowNotFoundError} for a workflow never created.
   */
  async duplicate(
    sourceDefinitionId: WorkflowDefinitionId,
    author: WorkflowSaveAuthor,
  ): Promise<WorkflowDefinitionCreateResponse> {
    const { document } = this.#library.read({ definitionId: sourceDefinitionId });
    const name = this.#library.firstFreeDuplicateName(document.name);
    return this.create({ document: { ...document, name } }, author, {
      savesNewWorkflowDraft: false,
    });
  }

  /**
   * Saves the document as the workflow's next version, only while `expectedVersionNumber` is still
   * its latest, and clears the workflow's draft in the same write. Rejects with
   * {@link WorkflowVersionStaleError} when it is not, {@link WorkflowDefinitionRefusedError} for
   * findings or a held name, and {@link WorkflowNotFoundError} for a workflow not in the library;
   * a refused save writes no row.
   */
  async update(
    request: WorkflowDefinitionUpdateRequest,
    author: WorkflowSaveAuthor,
  ): Promise<WorkflowDefinitionUpdateResponse> {
    const { definitionId, expectedVersionNumber, document } = request;
    this.#refuseFindings(document, definitionId);
    const { canonicalBody, contentHash } = hashWorkflowDocument(document);
    const workflowVersionId = mintUuidV7();
    const createdAt = this.#now().toISOString();
    try {
      await this.#writer.write([
        nameHolderStatement(foldName(document.name), definitionId),
        {
          sql: UPDATE_CURRENT_BODY_SQL,
          bindings: {
            id: definitionId,
            name: document.name,
            name_folded: foldName(document.name),
            content_hash: contentHash,
            schema_version: document.schemaVersion,
            definition_body: canonicalBody,
            updated_at: createdAt,
            expected_version_number: expectedVersionNumber,
          },
          expectedRowCount: 1,
        },
        {
          sql: INSERT_NEXT_VERSION_SQL,
          bindings: {
            id: workflowVersionId,
            definition_id: definitionId,
            content_hash: contentHash,
            definition_body: canonicalBody,
            layout_json: document.layout === undefined ? null : JSON.stringify(document.layout),
            created_at: createdAt,
            created_by: author.deviceId,
            saved_by_agent_id: author.agentId ?? null,
            expected_version_number: expectedVersionNumber,
          },
        },
        clearWorkflowDraftStatement(definitionId),
      ]);
    } catch (error) {
      if (!(error instanceof WriteRefusedError)) {
        throw error;
      }
      if (error.statementIndex === NAME_CHECK_INDEX) {
        throw new WorkflowDefinitionRefusedError([NAME_TAKEN_FINDING]);
      }
      throw this.#refusalForMissedVersion(definitionId, expectedVersionNumber);
    }
    return {
      definitionId,
      versionNumber: expectedVersionNumber + 1,
      workflowVersionId,
      contentHash,
      createdAt,
    };
  }

  /**
   * Marks the workflow deleted, disarms its triggers, and deletes its kept values and its draft,
   * in one write; its versions stay, so the runs pinned to them still read, and the reply counts
   * those runs. Rejects with {@link WorkflowNotFoundError} for a workflow not in the library.
   */
  async delete(definitionId: WorkflowDefinitionId): Promise<WorkflowDefinitionDeleteResponse> {
    let pinnedRunCount;
    try {
      [, , , , pinnedRunCount] = await this.#writer.write([
        {
          sql: SOFT_DELETE_SQL,
          bindings: { at: this.#now().toISOString(), id: definitionId },
          expectedRowCount: 1,
        },
        { sql: DISARM_TRIGGERS_SQL, bindings: [definitionId] },
        clearKeptValuesStatement(definitionId),
        clearWorkflowDraftStatement(definitionId),
        { sql: COUNT_PINNED_RUNS_SQL, bindings: [definitionId] },
      ]);
    } catch (error) {
      throw error instanceof WriteRefusedError
        ? new WorkflowNotFoundError({ definitionId })
        : error;
    }
    const counted = pinnedRunCount?.rows[0] as { run_count: number } | undefined;
    return { definitionId, deleted: true, retainedRunCount: counted?.run_count ?? 0 };
  }

  /**
   * Stores the canvas layout on the definition, minting no version; saved versions keep the
   * layout they were written with. Each setting rejects with {@link WorkflowNotFoundError} for a
   * workflow not in the library.
   */
  async setLayout(request: WorkflowLayoutSetRequest): Promise<WorkflowDefinitionSettingResponse> {
    const layoutJson = JSON.stringify(request.layout);
    return this.#writeSetting(request.definitionId, SET_LAYOUT_SQL, layoutJson);
  }

  /** Replaces the workflow's tags, minting no version. */
  async setTags(request: WorkflowTagsSetRequest): Promise<WorkflowDefinitionSettingResponse> {
    return this.#writeSetting(request.definitionId, SET_TAGS_SQL, JSON.stringify(request.tags));
  }

  /** Sets the level every run of the workflow uses, minting no version. */
  async updatePermissionLevel(
    request: WorkflowPermissionLevelUpdateRequest,
  ): Promise<WorkflowPermissionLevelUpdateResponse> {
    await this.#writeSetting(request.definitionId, SET_PERMISSION_LEVEL_SQL, request.level);
    return { definitionId: request.definitionId, level: request.level };
  }

  /** Pins items onto one node, or unpins it with null, minting no version. */
  async setPinData(request: WorkflowPinDataSetRequest): Promise<WorkflowPinDataSetResponse> {
    const { definitionId, nodeId, items } = request;
    await this.#writeToLiveDefinition(
      {
        sql: SET_PIN_DATA_SQL,
        bindings: [nodeId, JSON.stringify(items), this.#now().toISOString(), definitionId],
      },
      definitionId,
    );
    return { definitionId, nodeId, pinned: items !== null };
  }

  async #writeSetting(
    definitionId: WorkflowDefinitionId,
    sql: string,
    value: string,
  ): Promise<WorkflowDefinitionSettingResponse> {
    const updatedAt = this.#now().toISOString();
    await this.#writeToLiveDefinition(
      { sql, bindings: [value, updatedAt, definitionId] },
      definitionId,
    );
    return { definitionId, updatedAt };
  }

  // Runs one change that must touch the live definition's row, else refuses it as not found.
  async #writeToLiveDefinition(
    statement: WriteStatement,
    definitionId: WorkflowDefinitionId,
  ): Promise<void> {
    try {
      await this.#writer.write([{ ...statement, expectedRowCount: 1 }]);
    } catch (error) {
      throw error instanceof WriteRefusedError
        ? new WorkflowNotFoundError({ definitionId })
        : error;
    }
  }

  // Every graph finding and a held name are refused together, so the author sees them all at once.
  #refuseFindings(document: WorkflowDocument, savedDefinitionId?: WorkflowDefinitionId): void {
    const findings = checkWorkflowGraph(document, this.#resolveNodeHandles);
    if (this.#library.isNameHeld(document.name, savedDefinitionId)) {
      findings.push(NAME_TAKEN_FINDING);
    }
    if (findings.length > 0) {
      throw new WorkflowDefinitionRefusedError(findings);
    }
  }

  // A save whose staleness check matched no row: the workflow is gone, or another save came first.
  #refusalForMissedVersion(
    definitionId: WorkflowDefinitionId,
    expectedVersionNumber: number,
  ): Error {
    const row = this.#selectLatestVersion.get({ id: definitionId });
    if (row === undefined || row.deleted_at !== null || row.latest_version_number === null) {
      return new WorkflowNotFoundError({ definitionId });
    }
    return new WorkflowVersionStaleError(
      definitionId,
      expectedVersionNumber,
      row.latest_version_number,
    );
  }
}
