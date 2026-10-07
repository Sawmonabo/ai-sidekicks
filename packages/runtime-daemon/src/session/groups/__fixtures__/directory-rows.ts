// Raw-SQL seeding of the directory rows the group, link and related-list tests start from: a
// session's `sessions` row, and for a project or chat session the mount and workspace it binds.

import type { RepoMountId } from "@ai-sidekicks/contracts/repo/mount";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { DatabaseWriter } from "../../../database/writer.js";
import { mintUuidV7 } from "../../../uuid-v7.js";

const SEEDED_AT = "2026-10-06T12:00:00.000Z";

/** A fresh session id. */
export function mintSessionId(): SessionId {
  return mintUuidV7() as SessionId;
}

/** Seeds a session's `sessions` row with no binding, the shape given. */
export async function seedSessionRow(
  writer: Pick<DatabaseWriter, "write">,
  sessionId: SessionId,
  shape: "chat" | "project" = "project",
): Promise<void> {
  await writer.write([
    {
      sql: `INSERT INTO sessions (id, shape, state, created_at, updated_at, last_activity_at)
            VALUES (?, ?, 'active', ?, ?, ?)`,
      bindings: [sessionId, shape, SEEDED_AT, SEEDED_AT, SEEDED_AT],
    },
  ]);
}

/** Seeds an attached project mount and answers its id. */
export async function seedProjectMount(
  writer: Pick<DatabaseWriter, "write">,
): Promise<RepoMountId> {
  const repoMountId = mintUuidV7() as RepoMountId;
  await writer.write([
    {
      sql: `INSERT INTO repo_mounts (id, node_id, local_path, canonical_root, attached_at, updated_at)
            VALUES (?, 'node-1', ?, ?, ?, ?)`,
      bindings: [
        repoMountId,
        `/repos/${repoMountId}`,
        `/repos/${repoMountId}`,
        SEEDED_AT,
        SEEDED_AT,
      ],
    },
  ]);
  return repoMountId;
}

/** Seeds a project session bound to the mount through a workspace and answers its id. */
export async function seedProjectSession(
  writer: Pick<DatabaseWriter, "write">,
  repoMountId: RepoMountId,
): Promise<SessionId> {
  const sessionId = mintSessionId();
  await seedSessionRow(writer, sessionId, "project");
  await seedWorkspace(writer, sessionId, repoMountId);
  return sessionId;
}

/** Seeds a chat session bound to a managed mount of its own and answers its id. */
export async function seedChatSession(writer: Pick<DatabaseWriter, "write">): Promise<SessionId> {
  const sessionId = mintSessionId();
  const repoMountId = mintUuidV7();
  await seedSessionRow(writer, sessionId, "chat");
  await writer.write([
    {
      sql: `INSERT INTO repo_mounts
              (id, node_id, local_path, canonical_root, origin, managed_session_id, attached_at,
               updated_at)
            VALUES (?, 'node-1', ?, ?, 'managed', ?, ?, ?)`,
      bindings: [
        repoMountId,
        `/workspaces/${sessionId}`,
        `/workspaces/${sessionId}`,
        sessionId,
        SEEDED_AT,
        SEEDED_AT,
      ],
    },
  ]);
  await seedWorkspace(writer, sessionId, repoMountId);
  return sessionId;
}

async function seedWorkspace(
  writer: Pick<DatabaseWriter, "write">,
  sessionId: SessionId,
  repoMountId: string,
): Promise<void> {
  await writer.write([
    {
      sql: `INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, created_at,
                                    updated_at)
            VALUES (?, ?, ?, 'bound-root', ?, ?)`,
      bindings: [mintUuidV7(), sessionId, repoMountId, SEEDED_AT, SEEDED_AT],
    },
  ]);
}
