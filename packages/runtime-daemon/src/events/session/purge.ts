// The whole-session purge: deletes the event, snapshot, draft and directory rows of each session a
// person deletes, outright, then a chat's managed workspace, re-scores the related lists of the
// sessions it was linked to, appends one receipt naming every session that lost rows, then
// truncates the write-ahead log.
//
// It is the only operation in this package that removes a committed row of the append-only log.
// Nothing in the background calls it. The caller chooses the sessions and owns the precondition
// that each is archived or closed and locked against new work while the purge runs; this module
// does not read session state.
//
//   - `event_maintenance` rows are never purged: the delete excludes them in SQL, and they record
//     maintenance, this purge's own receipt included.
//   - The writer's connection runs with `secure_delete` on, so a freed page is overwritten with
//     zeros. The write-ahead log still holds the deleted pages' earlier images until a checkpoint,
//     so the purge ends with the writer's `TRUNCATE` checkpoint once its deletes and its receipt
//     have committed.
//   - The purge refuses to start inside an append-lock hold. The lock is reentrant per owner, so a
//     purge entered inside a hold would delete rows outside the serialization the hold provides.
//   - A refused session does not stop the deletion; the others are independent. Each session's
//     range read and deletes go in one write, so a refused session lost nothing and the receipt
//     does not name it. Each refusal is on that session's outcome.
//   - Each session is deleted under one hold of its append lock. The receipt is appended after
//     every session, outside every hold, because the append takes its own lock.
//   - A chat's managed workspace is deleted once its session's rows have committed, so a refused
//     session keeps its folder. A deletion that fails then is on the deletion's `refusedReason`.
//   - The sessions a purged one was linked to are read in the write that deletes its links, and
//     re-scored once every session is done, so no stored score keeps a share of a gone session.

import {
  DAEMON_SCOPE_SENTINEL_SESSION_ID,
  EventEnvelopeVersionSchema,
} from "@ai-sidekicks/contracts/event/envelope";
import { EventCompactedPayloadSchema } from "@ai-sidekicks/contracts/event/declared-variants";
import type { EventCategory, EventEnvelopeVersion } from "@ai-sidekicks/contracts/event/envelope";
import type {
  EventCompactedPayload,
  EventCompactedRemovedSession,
} from "@ai-sidekicks/contracts/event/declared-variants";
import type { NodeId } from "@ai-sidekicks/contracts/runtime-node/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { WriteStatement } from "../../database/statement.js";
import { WriteRefusedError, type DatabaseWriter } from "../../database/writer.js";
import type {
  EventLogAppendOptions,
  EventLogAppendReceipt,
  UnsequencedEventEnvelope,
} from "../log-service.js";
import { sessionAppendLock } from "./append-lock.js";
import type { SessionRelatedRanking } from "../../session/related/ranking.js";
import { mintUuidV7 } from "../../uuid-v7.js";
import type { ManagedWorkspaceService } from "../../workspace/managed/service.js";

/** The category a purge never touches: maintenance records, its own receipt included. */
const NEVER_PURGED_EVENT_CATEGORIES: readonly EventCategory[] = ["event_maintenance"];

// The same categories as a SQL literal list, interpolated rather than bound, so no statement's
// correctness depends on where the shared WHERE fragment sits among positional binds.
// `EventCategory` is a closed union of bare identifiers, so nothing needs escaping. Derived from
// the array so the two cannot drift.
const NEVER_PURGED_CATEGORY_SQL_LIST: string = NEVER_PURGED_EVENT_CATEGORIES.map(
  (category) => `'${category}'`,
).join(", ");

const PURGEABLE_WHERE = `session_id = ? AND category NOT IN (${NEVER_PURGED_CATEGORY_SQL_LIST})`;

// The receipt's envelope category, type and version. The version is parsed through its schema, so
// a literal that stops satisfying the grammar throws at import rather than at the first receipt.
const EVENT_MAINTENANCE_CATEGORY: EventCategory = "event_maintenance";
const PURGE_RECEIPT_TYPE = "event.compacted" as const;
const PURGE_RECEIPT_VERSION: EventEnvelopeVersion = EventEnvelopeVersionSchema.parse("1.0");

/** What one deletion did to one of its sessions, or refused to do and why. */
export interface SessionPurgeOutcome {
  readonly sessionId: SessionId;
  /** Event rows deleted. */
  readonly rowsDeleted: number;
  /** The lowest and highest sequence deleted; absent when no row was. */
  readonly fromSequence?: number | undefined;
  readonly toSequence?: number | undefined;
  /** Present iff this session was refused; a refused session lost no row. */
  readonly refusedReason?: string | undefined;
}

/** What one deletion did. */
export interface SessionPurgeResult {
  /** The receipt's `operationId`. */
  readonly operationId: string;
  /** One entry per session the deletion was asked to remove, in order. */
  readonly outcomes: readonly SessionPurgeOutcome[];
  /**
   * Present iff the deletion as a whole was refused or did not finish: before any session was
   * touched (the lock-hold check; `outcomes` is then empty), when a chat's managed workspace or
   * the receipt could not be deleted or appended after rows were deleted, or when the write-ahead
   * log could not be truncated.
   */
  readonly refusedReason?: string | undefined;
}

/** The durable append seam for the receipt; structural, so a test can pass a recording double. */
export interface SessionPurgeEventLog {
  append(
    envelope: UnsequencedEventEnvelope,
    options?: EventLogAppendOptions,
  ): Promise<EventLogAppendReceipt>;
}

/** Construction dependencies. */
export interface SessionPurgeDeps {
  /** The writer every delete and the checkpoint go through; its connection has `secure_delete` on. */
  readonly writer: Pick<DatabaseWriter, "write" | "checkpoint">;
  /** This daemon's NodeId, attributed in every receipt. */
  readonly nodeId: NodeId;
  /** Where the receipt is appended. */
  readonly eventLog: SessionPurgeEventLog;
  /** Deletes a chat's managed workspace; a project session has none, and nothing is deleted. */
  readonly managedWorkspaces: Pick<ManagedWorkspaceService, "delete">;
  /** Re-scores, in the background, the related lists of the sessions a purged one was linked to. */
  readonly relatedRanking: Pick<SessionRelatedRanking, "rescoreAround">;
  /** The clock for the receipt's timestamps. */
  readonly now?: () => Date;
  /** Mints the receipt's `operationId`. Defaults to `mintUuidV7`. */
  readonly operationIdFactory?: () => string;
  /** Mints the receipt row's id. Defaults to `mintUuidV7`. */
  readonly newEventId?: () => string;
}

// The range read's row once rows were deleted: its guard returns it only when both ends are safe
// integers.
interface PurgeRangeRow {
  readonly fromSequence: number;
  readonly toSequence: number;
}

// One session's outcome, and the sessions it was linked to when its rows were deleted.
interface SessionRowsDeletion {
  readonly outcome: SessionPurgeOutcome;
  readonly linkedSessionIds: readonly SessionId[];
}

// Thrown to refuse one session. Caught in `purge` and turned into its `refusedReason`; never
// escapes it.
class SessionPurgeRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionPurgeRefusal";
  }
}

/** Deletes the sessions one deletion removes. */
export class SessionPurge {
  readonly #writer: Pick<DatabaseWriter, "write" | "checkpoint">;
  readonly #nodeId: NodeId;
  readonly #eventLog: SessionPurgeEventLog;
  readonly #managedWorkspaces: Pick<ManagedWorkspaceService, "delete">;
  readonly #relatedRanking: Pick<SessionRelatedRanking, "rescoreAround">;
  readonly #now: () => Date;
  readonly #operationIdFactory: () => string;
  readonly #newEventId: () => string;

  constructor(deps: SessionPurgeDeps) {
    this.#writer = deps.writer;
    this.#nodeId = deps.nodeId;
    this.#eventLog = deps.eventLog;
    this.#managedWorkspaces = deps.managedWorkspaces;
    this.#relatedRanking = deps.relatedRanking;
    this.#now = deps.now ?? ((): Date => new Date());
    this.#operationIdFactory = deps.operationIdFactory ?? mintUuidV7;
    this.#newEventId = deps.newEventId ?? mintUuidV7;
  }

  /**
   * Deletes every purgeable row of each session in `sessionIds` and a chat's managed workspace,
   * queues the related lists of the sessions they were linked to for re-scoring, appends one
   * receipt naming every session that lost rows, and truncates the write-ahead log.
   *
   * Never throws: every failure becomes a `refusedReason`, on the session it belongs to or on the
   * deletion.
   */
  async purge(sessionIds: readonly SessionId[]): Promise<SessionPurgeResult> {
    const operationId: string = this.#operationIdFactory();
    const purgeInstant: Date = this.#now();

    if (sessionAppendLock.isHeldHere()) {
      return {
        operationId,
        outcomes: [],
        refusedReason:
          "a purge entered inside a session append-lock hold would delete rows outside the " +
          "hold's serialization; refusing to delete any row.",
      };
    }

    const outcomes: SessionPurgeOutcome[] = [];
    const failures: string[] = [];
    const formerlyLinkedSessionIds = new Set<SessionId>();
    for (const sessionId of sessionIds) {
      const { outcome, linkedSessionIds } = await this.#purgeSession(sessionId);
      outcomes.push(outcome);
      for (const linkedSessionId of linkedSessionIds) {
        formerlyLinkedSessionIds.add(linkedSessionId);
      }
      if (outcome.refusedReason === undefined) {
        try {
          await this.#managedWorkspaces.delete({ sessionId });
        } catch (error) {
          failures.push(
            `the managed workspace of session ${sessionId} could not be deleted after its rows ` +
              `were: ${describeError(error)}`,
          );
        }
      }
    }
    for (const outcome of outcomes) {
      if (outcome.refusedReason === undefined) {
        formerlyLinkedSessionIds.delete(outcome.sessionId);
      }
    }
    if (formerlyLinkedSessionIds.size > 0) {
      this.#relatedRanking.rescoreAround([...formerlyLinkedSessionIds]);
    }

    // Destruction must never go unrecorded: the receipt names every session that lost rows.
    const removedSessions: EventCompactedRemovedSession[] = outcomes.flatMap((outcome) =>
      outcome.fromSequence !== undefined && outcome.toSequence !== undefined
        ? [
            {
              sessionId: outcome.sessionId,
              fromSeq: outcome.fromSequence,
              toSeq: outcome.toSequence,
            },
          ]
        : [],
    );
    if (removedSessions.length > 0) {
      try {
        await this.#appendReceipt(operationId, purgeInstant, removedSessions);
      } catch (error) {
        failures.push(
          `purge receipt append failed after rows of ${String(removedSessions.length)} ` +
            `sessions were deleted: ${describeError(error)}`,
        );
      }
      const checkpointFailure: string | undefined = await this.#truncateWriteAheadLog();
      if (checkpointFailure !== undefined) {
        failures.push(checkpointFailure);
      }
    }

    return {
      operationId,
      outcomes,
      refusedReason: failures.length > 0 ? failures.join("; ") : undefined,
    };
  }

  async #purgeSession(sessionId: SessionId): Promise<SessionRowsDeletion> {
    try {
      return await sessionAppendLock.run(sessionId, () => this.#deleteSessionRows(sessionId));
    } catch (error) {
      return {
        outcome: { sessionId, rowsDeleted: 0, refusedReason: describeError(error) },
        linkedSessionIds: [],
      };
    }
  }

  // One write: the range read, the linked sessions' read, the snapshots, the events and the
  // directory rows commit or roll back together.
  async #deleteSessionRows(sessionId: SessionId): Promise<SessionRowsDeletion> {
    const [rangeResult, linkedResult, , eventsResult] = await this.#writer
      .write(deleteSessionRowsStatements(sessionId))
      .catch((error: unknown) => {
        throw error instanceof WriteRefusedError
          ? new SessionPurgeRefusal(
              "the session's stored sequences are not safe integers; refusing to delete rows " +
                "whose range the receipt could not name.",
            )
          : error;
      });
    const linkedSessionIds = (
      linkedResult?.rows as readonly { readonly sessionId: SessionId }[]
    ).map((row) => row.sessionId);
    const rowsDeleted: number = eventsResult?.rowCount ?? 0;
    if (rowsDeleted === 0) {
      return { outcome: { sessionId, rowsDeleted }, linkedSessionIds };
    }
    const range = rangeResult?.rows[0] as PurgeRangeRow;
    return {
      outcome: {
        sessionId,
        rowsDeleted,
        fromSequence: range.fromSequence,
        toSequence: range.toSequence,
      },
      linkedSessionIds,
    };
  }

  /** Returns why the log could not be truncated, or undefined once it was. */
  async #truncateWriteAheadLog(): Promise<string | undefined> {
    try {
      const checkpoint = await this.#writer.checkpoint("TRUNCATE");
      if (!checkpoint.isBusy) {
        return undefined;
      }
    } catch (error) {
      return `the write-ahead log could not be truncated after the purge: ${describeError(error)}`;
    }
    return (
      "the write-ahead log could not be truncated after the purge, because another connection " +
      "held it; the deleted rows' earlier page images stay in it until the next checkpoint"
    );
  }

  /** Appends one receipt per deletion on the daemon-scope sentinel, naming each emptied session. */
  async #appendReceipt(
    operationId: string,
    purgeInstant: Date,
    removedSessions: EventCompactedRemovedSession[],
  ): Promise<void> {
    const occurredAt: string = purgeInstant.toISOString();
    const payload: EventCompactedPayload = EventCompactedPayloadSchema.parse({
      nodeId: this.#nodeId,
      operationId,
      occurredAt,
      removedSessions,
    });

    await this.#eventLog.append({
      id: this.#newEventId(),
      sessionId: DAEMON_SCOPE_SENTINEL_SESSION_ID,
      occurredAt,
      category: EVENT_MAINTENANCE_CATEGORY,
      type: PURGE_RECEIPT_TYPE,
      actor: null,
      payload,
      version: PURGE_RECEIPT_VERSION,
    });
  }
}

/**
 * The range read, the read of the sessions linked to it, and the deletes of one session. The range
 * read returns its row only while the stored sequences are safe integers, so a range the receipt
 * could not name refuses the write before anything is deleted. A snapshot names the event it
 * reflects, so snapshots go first. A link or a related-list entry goes whichever side names the
 * session. A group row is named by its sessions, so the group the session leaves empty goes after
 * the session's row; no other group is ever empty, because each group write keeps at least one
 * session in it.
 */
function deleteSessionRowsStatements(sessionId: SessionId): readonly WriteStatement[] {
  return [
    {
      sql: `SELECT MIN(sequence) AS fromSequence, MAX(sequence) AS toSequence
              FROM session_events
             WHERE ${PURGEABLE_WHERE}
            HAVING MIN(sequence) IS NULL
                OR (typeof(MIN(sequence)) = 'integer' AND typeof(MAX(sequence)) = 'integer'
                    AND MIN(sequence) >= 0 AND MAX(sequence) <= ${String(Number.MAX_SAFE_INTEGER)})`,
      bindings: [sessionId],
      expectedRowCount: 1,
    },
    {
      sql: `SELECT target_session_id AS sessionId FROM session_links WHERE source_session_id = ?
            UNION
            SELECT source_session_id FROM session_links WHERE target_session_id = ?`,
      bindings: [sessionId, sessionId],
    },
    { sql: "DELETE FROM session_snapshots WHERE session_id = ?", bindings: [sessionId] },
    { sql: `DELETE FROM session_events WHERE ${PURGEABLE_WHERE}`, bindings: [sessionId] },
    { sql: "DELETE FROM session_drafts WHERE session_id = ?", bindings: [sessionId] },
    { sql: "DELETE FROM session_run_activity WHERE session_id = ?", bindings: [sessionId] },
    { sql: "DELETE FROM session_console_state WHERE session_id = ?", bindings: [sessionId] },
    {
      sql: "DELETE FROM session_links WHERE source_session_id = ? OR target_session_id = ?",
      bindings: [sessionId, sessionId],
    },
    { sql: "DELETE FROM session_tags WHERE session_id = ?", bindings: [sessionId] },
    {
      sql: "DELETE FROM session_related WHERE session_id = ? OR related_session_id = ?",
      bindings: [sessionId, sessionId],
    },
    { sql: "DELETE FROM sessions WHERE id = ?", bindings: [sessionId] },
    {
      sql: `DELETE FROM session_groups
             WHERE NOT EXISTS (SELECT 1 FROM sessions WHERE sessions.group_id = session_groups.id)`,
    },
  ];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
