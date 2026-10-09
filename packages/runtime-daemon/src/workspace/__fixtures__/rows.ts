// Raw-SQL seeding of attached mounts with their project rows, and raw-SQL reading of the mount,
// workspace and event rows the workspace tests assert on.

import type { Database } from "better-sqlite3";

import { ProjectIdSchema, type ProjectId } from "@ai-sidekicks/contracts/project";

import type { WriteStatement } from "../../database/statement.js";
import { mintUuidV7 } from "../../uuid-v7.js";
import { COMMON_DIR_METADATA_PATH } from "../row-guards.js";

const SEEDED_AT = "2026-08-04T00:00:00.000Z";

// A setup the project list can read: nothing to copy or run, a minute's limit.
const EMPTY_SETUP = JSON.stringify({ filesToCopy: [], commands: [], timeLimitSeconds: 60 });

/** An attached mount to seed; every member but `id` and `canonicalRoot` has a default. */
export interface AttachedMountSeed {
  readonly id: string;
  readonly canonicalRoot: string;
  /** Defaults to the canonical root. */
  readonly localPath?: string;
  /** The identity anchor; absent seeds a mount without one, which skips the identity check. */
  readonly commonDir?: string;
  readonly nodeId?: string;
  /** Defaults to a fresh project, whose row the statements insert first. */
  readonly projectId?: ProjectId;
}

/** The statement that inserts an `active` project row with an empty setup. */
export function projectRowStatement(projectId: ProjectId): WriteStatement {
  return {
    sql: `INSERT INTO projects (id, name, slug, folder_path, state, setup, created_at, updated_at)
          VALUES (@id, @id, @id, @id, 'active', @setup, @now, @now)`,
    bindings: { id: projectId, setup: EMPTY_SETUP, now: SEEDED_AT },
  };
}

/** A fresh project id. */
export function mintProjectId(): ProjectId {
  return ProjectIdSchema.parse(mintUuidV7());
}

/**
 * The statements that insert an attached mount and, unless the seed names one, its own project
 * row first; run them through a writer or one by one on a raw connection.
 */
export function attachedMountRowStatements(seed: AttachedMountSeed): readonly WriteStatement[] {
  const projectId = seed.projectId ?? mintProjectId();
  const mountRow: WriteStatement = {
    sql: `INSERT INTO repo_mounts (
            id, node_id, local_path, canonical_root, vcs_type, origin, project_id, state,
            attached_at, updated_at, metadata
          ) VALUES (
            @id, @node_id, @local_path, @canonical_root, 'git', 'attached', @project_id,
            'attached', @now, @now,
            CASE WHEN @common_dir IS NULL THEN '{}'
                 ELSE json_set('{}', '${COMMON_DIR_METADATA_PATH}', @common_dir) END
          )`,
    bindings: {
      id: seed.id,
      node_id: seed.nodeId ?? "node-local",
      local_path: seed.localPath ?? seed.canonicalRoot,
      canonical_root: seed.canonicalRoot,
      project_id: projectId,
      common_dir: seed.commonDir ?? null,
      now: SEEDED_AT,
    },
  };
  return seed.projectId === undefined ? [projectRowStatement(projectId), mountRow] : [mountRow];
}

// Row and event readers use raw SQL, not a service call: durability is a claim about what is on
// disk, and reading back through the writing service would prove only that it agrees with itself.

/** A `repo_mounts` row as stored. */
interface StoredMountRow {
  readonly id: string;
  readonly node_id: string;
  readonly local_path: string;
  readonly canonical_root: string;
  readonly vcs_type: string;
  readonly state: string;
  readonly attached_at: string;
  readonly updated_at: string;
}

/** A `workspaces` row as stored. */
interface StoredWorkspaceRow {
  readonly id: string;
  readonly session_id: string;
  readonly repo_mount_id: string;
  readonly execution_mode: string;
  readonly fs_root: string | null;
  readonly state: string;
  readonly metadata: string;
  readonly updated_at: string;
}

/** A `session_events` row's envelope columns, payload still serialized. */
interface StoredEventEnvelopeRow {
  readonly type: string;
  readonly actor: string | null;
  readonly correlation_id: string | null;
  readonly payload: string;
}

function readMountRow(database: Database, repoMountId: string): StoredMountRow | undefined {
  return database
    .prepare(
      `SELECT id, node_id, local_path, canonical_root, vcs_type, state, attached_at, updated_at
         FROM repo_mounts WHERE id = ?`,
    )
    .get(repoMountId) as StoredMountRow | undefined;
}

/** Reads one mount row; throws when none has the id. */
export function requireMountRow(database: Database, repoMountId: string): StoredMountRow {
  const row = readMountRow(database, repoMountId);
  if (row === undefined) {
    throw new Error(`repo mount ${repoMountId} is absent; the caller expected a row`);
  }
  return row;
}

/** Reads one workspace row, or `undefined` when none has the id. */
export function readWorkspaceRow(
  database: Database,
  workspaceId: string,
): StoredWorkspaceRow | undefined {
  return database
    .prepare(
      `SELECT id, session_id, repo_mount_id, execution_mode, fs_root, state, metadata, updated_at
         FROM workspaces WHERE id = ?`,
    )
    .get(workspaceId) as StoredWorkspaceRow | undefined;
}

/** Reads one workspace row; throws when none has the id. */
export function requireWorkspaceRow(database: Database, workspaceId: string): StoredWorkspaceRow {
  const row = readWorkspaceRow(database, workspaceId);
  if (row === undefined) {
    throw new Error(`workspace ${workspaceId} is absent; the caller expected a row`);
  }
  return row;
}

/** The session's event types in sequence order. */
export function readLifecycleEventTypes(database: Database, sessionId: string): readonly string[] {
  return readLifecycleEnvelopes(database, sessionId).map((row) => row.type);
}

/** The session's event envelopes in sequence order. */
export function readLifecycleEnvelopes(
  database: Database,
  sessionId: string,
): readonly StoredEventEnvelopeRow[] {
  return database
    .prepare(
      `SELECT type, actor, correlation_id, payload FROM session_events
        WHERE session_id = ? ORDER BY sequence ASC`,
    )
    .all(sessionId) as readonly StoredEventEnvelopeRow[];
}
