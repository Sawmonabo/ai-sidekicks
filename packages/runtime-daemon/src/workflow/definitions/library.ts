// Reads of the one workflow library: a definition with its document, the list of every workflow
// not deleted, and whether a name is held, compared by its case fold.
import type { Statement } from "better-sqlite3";

import { foldName } from "@ai-sidekicks/contracts/name-fold";
import type { PermissionLevel } from "@ai-sidekicks/contracts/session/controls/methods";
import type {
  WorkflowDefinitionId,
  WorkflowNodeKindId,
} from "@ai-sidekicks/contracts/workflow/definition/document";
import type {
  WorkflowDefinitionListRequest,
  WorkflowDefinitionReadRequest,
  WorkflowDefinitionReadResponse,
  WorkflowDefinitionSummary,
} from "@ai-sidekicks/contracts/workflow/definition/methods";
import type { WorkflowRunId } from "@ai-sidekicks/contracts/workflow/run/id";
import type { WorkflowRunStatus } from "@ai-sidekicks/contracts/workflow/run/status";

import type { DatabaseConnections } from "../../database/connections.js";
import type { WriteStatement } from "../../database/statement.js";
import { WorkflowNotFoundError } from "../not-found.js";
import { readStoredWorkflowDocument } from "./stored-document.js";

// A definition never has the empty id, so binding it excludes no workflow.
const NO_DEFINITION_EXCLUDED = "";
const NAME_HOLDER_SQL = `SELECT id FROM workflow_definitions
  WHERE name_folded = ? AND deleted_at IS NULL AND id <> ? LIMIT 1`;
const LIVE_DEFINITION_SQL =
  "SELECT 1 FROM workflow_definitions WHERE id = ? AND deleted_at IS NULL";

// One statement, so the definition, its version and its token are read from one snapshot. The
// layout a read serves is the definition's own at the latest version and the snapshot otherwise.
const READ_DEFINITION_SQL = `SELECT definition.name,
    definition.layout_json AS definition_layout_json, definition.pin_data_json, definition.tags,
    definition.permission_level, definition.created_at, definition.deleted_at,
    version.id AS version_id, version.version_number, version.content_hash,
    version.schema_version, version.definition_body, version.layout_json AS version_layout_json,
    version.version_number = (
      SELECT MAX(version_number) FROM workflow_versions WHERE definition_id = definition.id
    ) AS is_latest,
    token.created_at AS webhook_token_created_at, token.last_used_at AS webhook_token_last_used_at
  FROM workflow_definitions definition
  JOIN workflow_versions version ON version.definition_id = definition.id
  LEFT JOIN workflow_webhook_tokens token ON token.definition_id = definition.id
  WHERE definition.id = @definition_id
    AND version.version_number = COALESCE(@version_number, (
      SELECT MAX(version_number) FROM workflow_versions WHERE definition_id = definition.id
    ))`;

// The last run is the one started last; a run not yet started has no start to show.
const LIST_DEFINITIONS_SQL = `SELECT definition.id, definition.name, definition.content_hash,
    definition.tags, definition.created_at,
    json_extract(definition.definition_body, '$.trigger.kind') AS trigger_kind,
    latest.id AS latest_version_id, latest.version_number AS latest_version_number,
    definition.updated_at,
    (SELECT COUNT(*) FROM workflow_runs run
      JOIN workflow_versions run_version ON run_version.id = run.workflow_version_id
      WHERE run_version.definition_id = definition.id) AS run_count,
    last_run.id AS last_run_id, last_run.status AS last_run_status,
    last_run.started_at AS last_run_started_at
  FROM workflow_definitions definition
  JOIN workflow_versions latest ON latest.id = (
    SELECT id FROM workflow_versions WHERE definition_id = definition.id
    ORDER BY version_number DESC LIMIT 1
  )
  LEFT JOIN workflow_runs last_run ON last_run.id = (
    SELECT run.id FROM workflow_runs run
      JOIN workflow_versions run_version ON run_version.id = run.workflow_version_id
      WHERE run_version.definition_id = definition.id AND run.started_at IS NOT NULL
      ORDER BY run.started_at DESC, run.id DESC LIMIT 1
  )
  WHERE definition.deleted_at IS NULL AND (@cursor IS NULL OR definition.id > @cursor)
  ORDER BY definition.id
  LIMIT @row_limit`;

// SQLite reads a negative limit as no limit.
const NO_ROW_LIMIT = -1;

interface DefinitionReadRow {
  readonly name: string;
  readonly definition_layout_json: string | null;
  readonly pin_data_json: string | null;
  readonly tags: string;
  readonly permission_level: PermissionLevel;
  readonly created_at: string;
  readonly deleted_at: string | null;
  readonly version_id: string;
  readonly version_number: number;
  readonly content_hash: string;
  readonly schema_version: string;
  readonly definition_body: string;
  readonly version_layout_json: string | null;
  readonly is_latest: 0 | 1;
  readonly webhook_token_created_at: string | null;
  readonly webhook_token_last_used_at: string | null;
}

interface DefinitionListRow {
  readonly id: string;
  readonly name: string;
  readonly content_hash: string;
  readonly tags: string;
  readonly created_at: string;
  readonly trigger_kind: WorkflowNodeKindId;
  readonly latest_version_id: string;
  readonly latest_version_number: number;
  readonly updated_at: string;
  readonly run_count: number;
  readonly last_run_id: string | null;
  readonly last_run_status: WorkflowRunStatus | null;
  readonly last_run_started_at: string | null;
}

/**
 * One workflow in the library list: what a catalog row shows from storage. Whether it is enabled,
 * its schedule and its last skipped fire come from the trigger scheduler, not from these tables.
 * `updatedAt` is the last change to the workflow's row.
 *
 * @consumedBy the workflow definition list handler
 */
export type WorkflowLibraryEntry = Omit<
  WorkflowDefinitionSummary,
  "enabled" | "schedule" | "lastSkippedFire"
>;

/** One page of the library, each workflow listed once across pages. */
export interface WorkflowLibraryPage {
  readonly definitions: WorkflowLibraryEntry[];
  readonly nextCursor?: string | undefined;
}

/**
 * The statement a save runs first, inside its own write, to refuse a name another workflow in the
 * library holds; it expects no row. `exceptDefinitionId` is the workflow being saved, whose own
 * name is no conflict.
 */
export function nameHolderStatement(
  nameFolded: string,
  exceptDefinitionId?: WorkflowDefinitionId,
): WriteStatement {
  return {
    sql: NAME_HOLDER_SQL,
    bindings: [nameFolded, exceptDefinitionId ?? NO_DEFINITION_EXCLUDED],
    expectedRowCount: 0,
  };
}

/**
 * The statement a write to a saved workflow runs first, inside that write, so a delete cannot land
 * between the check and the change; it expects the one row a workflow in the library returns.
 */
export function liveDefinitionStatement(definitionId: WorkflowDefinitionId): WriteStatement {
  return { sql: LIVE_DEFINITION_SQL, bindings: [definitionId], expectedRowCount: 1 };
}

/** Reads the one workflow library from the read-only connection. */
export class WorkflowLibrary {
  readonly #selectNameHolder: Statement<[string, string], { id: string }>;
  readonly #selectDefinition: Statement<
    [{ definition_id: string; version_number: number | null }],
    DefinitionReadRow
  >;
  readonly #selectDefinitions: Statement<
    [{ cursor: string | null; row_limit: number }],
    DefinitionListRow
  >;

  constructor(database: DatabaseConnections) {
    this.#selectNameHolder = database.reader.prepare(NAME_HOLDER_SQL);
    this.#selectDefinition = database.reader.prepare(READ_DEFINITION_SQL);
    this.#selectDefinitions = database.reader.prepare(LIST_DEFINITIONS_SQL);
  }

  /**
   * Whether a workflow in the library other than `exceptDefinitionId` holds the name, in any
   * letter case.
   */
  isNameHeld(name: string, exceptDefinitionId?: WorkflowDefinitionId): boolean {
    return (
      this.#selectNameHolder.get(foldName(name), exceptDefinitionId ?? NO_DEFINITION_EXCLUDED) !==
      undefined
    );
  }

  /** The first of `<name> copy`, `<name> copy 2`, `<name> copy 3` and on that no workflow holds. */
  firstFreeDuplicateName(name: string): string {
    const firstCandidate = `${name} copy`;
    let candidate = firstCandidate;
    for (let ordinal = 2; this.isNameHeld(candidate); ordinal += 1) {
      candidate = `${firstCandidate} ${String(ordinal)}`;
    }
    return candidate;
  }

  /**
   * One definition at the version asked for, else at its latest, with its document, permission
   * level and webhook token dates. A deleted workflow still reads. Throws
   * {@link WorkflowNotFoundError} when no such workflow or version exists.
   */
  read(request: WorkflowDefinitionReadRequest): WorkflowDefinitionReadResponse {
    const { definitionId, version } = request;
    const row = this.#selectDefinition.get({
      definition_id: definitionId,
      version_number: version ?? null,
    });
    if (row === undefined) {
      throw new WorkflowNotFoundError(
        version === undefined ? { definitionId } : { definitionId, versionNumber: version },
      );
    }
    const record = {
      id: definitionId,
      name: row.name,
      versionNumber: row.version_number,
      workflowVersionId: row.version_id,
      contentHash: row.content_hash,
      document: readStoredWorkflowDocument({
        schemaVersion: row.schema_version,
        definitionBody: row.definition_body,
        layoutJson: row.is_latest === 1 ? row.definition_layout_json : row.version_layout_json,
        pinDataJson: row.pin_data_json,
        tagsJson: row.tags,
      }),
      permissionLevel: row.permission_level,
      createdAt: row.created_at,
      ...(row.deleted_at === null ? {} : { deletedAt: row.deleted_at }),
    };
    if (row.webhook_token_created_at === null) {
      return record;
    }
    return row.webhook_token_last_used_at === null
      ? { ...record, webhookTokenCreatedAt: row.webhook_token_created_at }
      : {
          ...record,
          webhookTokenCreatedAt: row.webhook_token_created_at,
          webhookTokenLastUsedAt: row.webhook_token_last_used_at,
        };
  }

  /**
   * One page of every workflow not deleted, in the order they were created. The cursor is the
   * last id of the page before; a page with no limit holds every workflow after it.
   */
  list(request: WorkflowDefinitionListRequest): WorkflowLibraryPage {
    const { limit, cursor } = request;
    // One row past the page says whether another page follows.
    const rows = this.#selectDefinitions.all({
      cursor: cursor ?? null,
      row_limit: limit === undefined ? NO_ROW_LIMIT : limit + 1,
    });
    const pageRows = limit === undefined ? rows : rows.slice(0, limit);
    const definitions = pageRows.map(readLibraryEntry);
    const lastRow = pageRows.at(-1);
    return rows.length > pageRows.length && lastRow !== undefined
      ? { definitions, nextCursor: lastRow.id }
      : { definitions };
  }
}

function readLibraryEntry(row: DefinitionListRow): WorkflowLibraryEntry {
  const entry: WorkflowLibraryEntry = {
    id: row.id as WorkflowDefinitionId,
    name: row.name,
    latestVersionNumber: row.latest_version_number,
    latestWorkflowVersionId: row.latest_version_id,
    contentHash: row.content_hash,
    triggerKind: row.trigger_kind,
    tags: JSON.parse(row.tags) as string[],
    runCount: row.run_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (
    row.last_run_id !== null &&
    row.last_run_status !== null &&
    row.last_run_started_at !== null
  ) {
    entry.lastRun = {
      workflowRunId: row.last_run_id as WorkflowRunId,
      status: row.last_run_status,
      startedAt: row.last_run_started_at,
    };
  }
  return entry;
}
