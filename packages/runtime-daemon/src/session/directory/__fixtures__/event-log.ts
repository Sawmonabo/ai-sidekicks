// A scratch daemon database whose event log keeps the `sessions` rows in step, the way the daemon
// composes it, with the appends the session tests drive and a second log that loses an append.

import type { AgentId } from "@ai-sidekicks/contracts/agent/definition";
import {
  DAEMON_SCOPE_SENTINEL_SESSION_ID,
  EventEnvelopeVersionSchema,
  type EventCategory,
} from "@ai-sidekicks/contracts/event/envelope";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { SESSION_NAME_MAX_LEN, type SessionShape } from "@ai-sidekicks/contracts/session/methods";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import { EventLogService, type UnsequencedEventEnvelope } from "../../../events/log-service.js";
import {
  breakStoredEvent,
  holdReceiptOfAppend,
} from "../../../events/session/__fixtures__/log-faults.js";
import { mintUuidV7 } from "../../../uuid-v7.js";
import { directoryStatementsFor } from "../row.js";

const ENVELOPE_VERSION = EventEnvelopeVersionSchema.parse("1.0");
const OCCURRED_AT = "2026-10-06T12:00:00.000Z";

/** The scratch database, its event log, and the appends a list test makes. */
export interface SessionLog {
  readonly scratch: ScratchDatabase;
  readonly eventLog: EventLogService;
  /** Every line the log and what a test builds on it wrote to the service log, in order. */
  readonly serviceLogLines: string[];
  /** Writes one line to {@link SessionLog.serviceLogLines}. */
  readonly writeServiceLog: (line: string) => void;
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
  /**
   * Binds `sessionId` to the project `repoMountId` names, attaching a new project folder when it
   * names none; returns the mount's id.
   */
  bindToProject(sessionId: SessionId, repoMountId?: string): Promise<string>;
  /**
   * Writes `count` chats' rows straight to the table, each named and previewed at the wire's
   * bound in three-byte characters, so a few thousand outgrow one message; returns their ids.
   */
  seedWideChats(count: number): Promise<SessionId[]>;
  /** Deletes the session's row, then appends the purge receipt naming it. */
  purge(sessionId: SessionId): Promise<void>;
  /** Opens a second event log on the scratch database, writing to the same service log. */
  openLossyLog(): LossyEventLog;
}

/** A second event log on the scratch database, whose first append its followers lose. */
interface LossyEventLog {
  readonly eventLog: EventLogService;
  /**
   * Appends `lost` and breaks its stored row once it commits, then appends `next`, so the log's
   * followers hear of `next` first and cannot read `lost` back: a gap in `lost`'s session.
   */
  appendLosing(lost: UnsequencedEventEnvelope, next: UnsequencedEventEnvelope): Promise<void>;
}

/** Builds one event of `sessionId`, as the session tests append it. */
export function buildSessionEvent(
  sessionId: SessionId,
  type: string,
  category: EventCategory,
  payload: Record<string, unknown>,
  occurredAt: string = OCCURRED_AT,
): UnsequencedEventEnvelope {
  return {
    id: mintUuidV7(),
    sessionId,
    occurredAt,
    category,
    type,
    actor: null,
    payload,
    version: ENVELOPE_VERSION,
  };
}

/** Builds the purge receipt, in the machine's own scope, naming the one session it removed. */
export function buildPurgeReceipt(sessionId: SessionId): UnsequencedEventEnvelope {
  return buildSessionEvent(
    DAEMON_SCOPE_SENTINEL_SESSION_ID,
    "event.compacted",
    "event_maintenance",
    {
      nodeId: mintUuidV7(),
      operationId: mintUuidV7(),
      occurredAt: OCCURRED_AT,
      removedSessions: [{ sessionId, fromSeq: 0, toSeq: 9 }],
    },
  );
}

/** Opens a fresh scratch database and its event log. */
export async function openSessionLog(): Promise<SessionLog> {
  const scratch = await openScratchDatabase();
  const serviceLogLines: string[] = [];
  const writeServiceLog = (line: string): void => {
    serviceLogLines.push(line);
  };
  const eventLog = new EventLogService({
    writer: scratch.writer,
    reader: scratch.reader,
    projectionStatements: directoryStatementsFor,
    writeServiceLog,
  });
  const append: SessionLog["append"] = async (sessionId, type, category, payload, occurredAt) => {
    await eventLog.append(buildSessionEvent(sessionId, type, category, payload, occurredAt));
  };
  return {
    scratch,
    eventLog,
    serviceLogLines,
    writeServiceLog,
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
          createdAt: OCCURRED_AT,
        },
      });
      await append(sessionId, "session.activated", "session_lifecycle", {
        sessionId,
        previousState: "provisioning",
        newState: "active",
      });
    },
    bindToProject: async (sessionId, knownRepoMountId) => {
      const repoMountId = knownRepoMountId ?? mintUuidV7();
      await scratch.writer.write([
        ...(knownRepoMountId === undefined
          ? [
              {
                sql: `INSERT INTO repo_mounts (id, node_id, local_path, canonical_root,
                                               attached_at, updated_at)
                      VALUES (?, ?, ?, ?, ?, ?)`,
                bindings: [
                  repoMountId,
                  mintUuidV7(),
                  `/work/${repoMountId}`,
                  `/work/${repoMountId}`,
                  OCCURRED_AT,
                  OCCURRED_AT,
                ],
              },
            ]
          : []),
        {
          sql: `INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, created_at,
                                        updated_at)
                VALUES (?, ?, ?, 'bound-root', ?, ?)`,
          bindings: [mintUuidV7(), sessionId, repoMountId, OCCURRED_AT, OCCURRED_AT],
        },
      ]);
      return repoMountId;
    },
    seedWideChats: async (count) => {
      const sessionIds = Array.from({ length: count }, () => mintUuidV7() as SessionId);
      const wideText = "語".repeat(SESSION_NAME_MAX_LEN);
      await scratch.writer.write(
        sessionIds.map((sessionId) => ({
          sql: `INSERT INTO sessions (id, shape, state, name, first_message_preview, created_at,
                                      updated_at, last_activity_at)
                VALUES (?, 'chat', 'active', ?, ?, ?, ?, ?)`,
          bindings: [sessionId, wideText, wideText, OCCURRED_AT, OCCURRED_AT, OCCURRED_AT],
        })),
      );
      return sessionIds;
    },
    purge: async (sessionId) => {
      await scratch.writer.write([
        { sql: "DELETE FROM sessions WHERE id = ?", bindings: [sessionId], expectedRowCount: 1 },
      ]);
      await eventLog.append(buildPurgeReceipt(sessionId));
    },
    openLossyLog: () => {
      const holding = holdReceiptOfAppend(scratch.writer, 1);
      const lossyLog = new EventLogService({
        writer: holding.writer,
        reader: scratch.reader,
        projectionStatements: directoryStatementsFor,
        writeServiceLog,
      });
      return {
        eventLog: lossyLog,
        appendLosing: async (lost, next) => {
          const lostAppend = lossyLog.append(lost);
          const [lostSequence] = await holding.committed;
          await breakStoredEvent(scratch.writer, lost.sessionId, lostSequence!);
          await lossyLog.append(next);
          holding.release();
          await lostAppend;
        },
      };
    },
  };
}

/** Crosses one turn of the event loop, after the list feed reads the sessions it was told of. */
export async function crossEventLoopTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
