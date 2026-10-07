// A scratch daemon database whose event log keeps the `sessions` rows in step, the way the daemon
// composes it, with the appends the sessions list tests drive.

import type { AgentId } from "@ai-sidekicks/contracts/agent/definition";
import {
  DAEMON_SCOPE_SENTINEL_SESSION_ID,
  EventEnvelopeVersionSchema,
  type EventCategory,
} from "@ai-sidekicks/contracts/event/envelope";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { SessionShape } from "@ai-sidekicks/contracts/session/methods";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import { EventLogService } from "../../../events/log-service.js";
import { mintUuidV7 } from "../../../uuid-v7.js";
import { directoryStatementsFor } from "../row.js";

const ENVELOPE_VERSION = EventEnvelopeVersionSchema.parse("1.0");

/** The scratch database, its event log, and the appends a list test makes. */
export interface SessionLog {
  readonly scratch: ScratchDatabase;
  readonly eventLog: EventLogService;
  /** Appends one event of `sessionId` at `occurredAt` and waits for its commit. */
  append(
    sessionId: SessionId,
    type: string,
    category: EventCategory,
    payload: Record<string, unknown>,
    occurredAt?: string,
  ): Promise<void>;
  /** Creates a session of `shape` and activates it. */
  createSession(sessionId: SessionId, shape: SessionShape): Promise<void>;
  /** Attaches a project folder and binds `sessionId` to it; returns the mount's id. */
  bindToProject(sessionId: SessionId): Promise<string>;
  /** Deletes the session's row, then appends the purge receipt naming it. */
  purge(sessionId: SessionId): Promise<void>;
}

/** Opens a fresh scratch database and its event log. */
export async function openSessionLog(): Promise<SessionLog> {
  const scratch = await openScratchDatabase();
  const eventLog = new EventLogService({
    writer: scratch.writer,
    reader: scratch.reader,
    projectionStatements: directoryStatementsFor,
  });
  const append: SessionLog["append"] = async (
    sessionId,
    type,
    category,
    payload,
    occurredAt = "2026-10-06T12:00:00.000Z",
  ) => {
    await eventLog.append({
      id: mintUuidV7(),
      sessionId,
      occurredAt,
      category,
      type,
      actor: null,
      payload,
      version: ENVELOPE_VERSION,
    });
  };
  return {
    scratch,
    eventLog,
    append,
    createSession: async (sessionId, shape) => {
      await append(sessionId, "session.created", "session_lifecycle", {
        sessionId,
        shape,
        mainAgent: {
          agentId: mintUuidV7() as AgentId,
          name: "Implementer",
          binding: {
            driverName: "claude",
            modelId: "claude-sonnet-5",
            providerAccountId: null,
            effort: null,
          },
          ancestry: [],
          createdAt: "2026-10-06T12:00:00.000Z",
        },
      });
      await append(sessionId, "session.activated", "session_lifecycle", {
        sessionId,
        previousState: "provisioning",
        newState: "active",
      });
    },
    bindToProject: async (sessionId) => {
      const repoMountId = mintUuidV7();
      const now = "2026-10-06T12:00:00.000Z";
      await scratch.writer.write([
        {
          sql: `INSERT INTO repo_mounts (id, node_id, local_path, canonical_root, attached_at,
                                         updated_at)
                VALUES (?, ?, ?, ?, ?, ?)`,
          bindings: [
            repoMountId,
            mintUuidV7(),
            `/work/${repoMountId}`,
            `/work/${repoMountId}`,
            now,
            now,
          ],
        },
        {
          sql: `INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, created_at,
                                        updated_at)
                VALUES (?, ?, ?, 'bound-root', ?, ?)`,
          bindings: [mintUuidV7(), sessionId, repoMountId, now, now],
        },
      ]);
      return repoMountId;
    },
    purge: async (sessionId) => {
      await scratch.writer.write([
        { sql: "DELETE FROM sessions WHERE id = ?", bindings: [sessionId], expectedRowCount: 1 },
      ]);
      await append(DAEMON_SCOPE_SENTINEL_SESSION_ID, "event.compacted", "event_maintenance", {
        nodeId: mintUuidV7(),
        operationId: mintUuidV7(),
        occurredAt: "2026-10-06T12:00:00.000Z",
        removedSessions: [{ sessionId, fromSeq: 0, toSeq: 9 }],
      });
    },
  };
}

/** Crosses one turn of the event loop, after the list feed reads the sessions it was told of. */
export async function crossEventLoopTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
