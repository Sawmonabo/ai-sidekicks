// Raw-SQL seeding and reading of the mount, workspace and event rows the workspace tests assert on.

import type { Database } from "better-sqlite3";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { DatabaseWriter } from "../../database/writer.js";
import { insertStoredEvent } from "../../session/__fixtures__/stored-event.js";

/** Seeds a session's log so `SessionService.rebuildSession` returns a snapshot for it. */
export async function seedSession(
  writer: Pick<DatabaseWriter, "write">,
  sessionId: SessionId,
): Promise<void> {
  await insertStoredEvent(writer, {
    id: `evt-${sessionId}`,
    sessionId,
    sequence: 0,
    occurredAt: "2026-08-05T00:00:00.000Z",
    monotonicNs: 1_000_000_000n,
    category: "session_lifecycle",
    type: "session.created",
    actor: null,
    payload: { sessionId },
    correlationId: null,
    causationId: null,
    version: "1.0",
  });
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

/**
 * The session's event types in sequence order, without the seeded `session.created` anchor, which
 * exists only because `rebuildSession` refuses a log that does not start with it.
 */
export function readLifecycleEventTypes(database: Database, sessionId: string): readonly string[] {
  return readLifecycleEnvelopes(database, sessionId).map((row) => row.type);
}

/** The session's event envelopes in sequence order, without the seeded `session.created` anchor. */
export function readLifecycleEnvelopes(
  database: Database,
  sessionId: string,
): readonly StoredEventEnvelopeRow[] {
  return (
    database
      .prepare(
        `SELECT type, actor, correlation_id, payload FROM session_events
          WHERE session_id = ? ORDER BY sequence ASC`,
      )
      .all(sessionId) as readonly StoredEventEnvelopeRow[]
  ).filter((row) => row.type !== "session.created");
}
