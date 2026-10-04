// The whole-session purge: deletes the event and snapshot rows of each session a person deletes,
// outright, appends one receipt naming every session that lost rows, then truncates the
// write-ahead log.
//
// It is the only operation in this package that removes a committed row of the append-only log.
// Nothing in the background calls it. The caller chooses the sessions and owns the precondition
// that each is archived or closed and locked against new work while the purge runs; this module
// does not read session state.
//
//   - `event_maintenance` rows are never purged: the delete excludes them in SQL, and they record
//     maintenance, this purge's own receipt included.
//   - The connection runs with `secure_delete` on, so a freed page is overwritten with zeros. The
//     write-ahead log still holds the deleted pages' earlier images until a checkpoint, so the
//     purge ends with `wal_checkpoint(TRUNCATE)` once its deletes and its receipt have committed.
//   - The purge refuses to start inside an append-lock hold. The lock is reentrant per owner, so a
//     purge entered inside a hold would delete rows outside the serialization the hold provides.
//   - A refused session does not stop the deletion; the others are independent. Each session's
//     rows go in one transaction, so a refused session lost nothing and the receipt does not name
//     it. Each refusal is on that session's outcome.
//   - Each session is deleted under one hold of its append lock. The receipt is appended after
//     every session, outside every hold, because the append takes its own lock.

import {
  DAEMON_SCOPE_SENTINEL_SESSION_ID,
  EventEnvelopeVersionSchema,
} from "@ai-sidekicks/contracts/event-envelope";
import { EventCompactedPayloadSchema } from "@ai-sidekicks/contracts/event-declared-variants";
import type { EventCategory, EventEnvelopeVersion } from "@ai-sidekicks/contracts/event-envelope";
import type {
  EventCompactedPayload,
  EventCompactedRemovedSession,
} from "@ai-sidekicks/contracts/event-declared-variants";
import type { NodeId } from "@ai-sidekicks/contracts/node-id";
import type { SessionId } from "@ai-sidekicks/contracts/session";
import type { Database, Statement } from "better-sqlite3";

import type {
  EventLogAppendOptions,
  EventLogAppendReceipt,
  UnsequencedEventEnvelope,
} from "./event-log-service.js";
import { isWithinSessionAppendLockHold, withSessionAppendLock } from "./session-append-lock.js";
import { mintUuidV7 } from "../ids/uuid-v7.js";

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
   * touched (the lock-hold check; `outcomes` is then empty), when the receipt could not be
   * appended after rows were deleted, or when the write-ahead log could not be truncated.
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
  /** The connection every delete and the checkpoint run on, opened with `secure_delete` on. */
  readonly db: Database;
  /** This daemon's NodeId, attributed in every receipt. */
  readonly nodeId: NodeId;
  /** Where the receipt is appended. */
  readonly eventLog: SessionPurgeEventLog;
  /** The clock for the receipt's timestamps. */
  readonly now?: () => Date;
  /** Mints the receipt's `operationId`. Defaults to `mintUuidV7`. */
  readonly operationIdFactory?: () => string;
  /** Mints the receipt row's id. Defaults to `mintUuidV7`. */
  readonly newEventId?: () => string;
}

// The range read's raw shape. Every member is `unknown` because column types are claims
// TypeScript never checked; the read boundary is where they are checked.
interface PurgeRangeRow {
  readonly fromSequence: unknown;
  readonly toSequence: unknown;
}

// One row of `PRAGMA wal_checkpoint`: `busy` is 1 when a reader or writer kept the checkpoint
// from completing, so the log was not truncated.
interface WalCheckpointRow {
  readonly busy: number;
}

// Thrown to abort one session or the whole deletion. Caught in `purge` and turned into a
// `refusedReason`; never escapes it.
class SessionPurgeRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionPurgeRefusal";
  }
}

/** Deletes the sessions one deletion removes. */
export class SessionPurge {
  readonly #db: Database;
  readonly #nodeId: NodeId;
  readonly #eventLog: SessionPurgeEventLog;
  readonly #now: () => Date;
  readonly #operationIdFactory: () => string;
  readonly #newEventId: () => string;

  readonly #rangeStmt: Statement;
  readonly #deleteSnapshotsStmt: Statement;
  readonly #deleteEventsStmt: Statement;

  constructor(deps: SessionPurgeDeps) {
    this.#db = deps.db;
    this.#nodeId = deps.nodeId;
    this.#eventLog = deps.eventLog;
    this.#now = deps.now ?? ((): Date => new Date());
    this.#operationIdFactory = deps.operationIdFactory ?? mintUuidV7;
    this.#newEventId = deps.newEventId ?? mintUuidV7;

    this.#rangeStmt = deps.db.prepare(
      `SELECT MIN(sequence) AS fromSequence, MAX(sequence) AS toSequence
         FROM session_events
        WHERE ${PURGEABLE_WHERE}`,
    );
    // A snapshot names the event it reflects, so the session's snapshots go first.
    this.#deleteSnapshotsStmt = deps.db.prepare(
      "DELETE FROM session_snapshots WHERE session_id = ?",
    );
    this.#deleteEventsStmt = deps.db.prepare(`DELETE FROM session_events WHERE ${PURGEABLE_WHERE}`);
  }

  /**
   * Deletes every purgeable row of each session in `sessionIds`, appends one receipt naming every
   * session that lost rows, and truncates the write-ahead log.
   *
   * Never throws: every failure becomes a `refusedReason`, on the session it belongs to or on the
   * deletion.
   */
  async purge(sessionIds: readonly SessionId[]): Promise<SessionPurgeResult> {
    const operationId: string = this.#operationIdFactory();
    const purgeInstant: Date = this.#now();

    if (isWithinSessionAppendLockHold()) {
      return {
        operationId,
        outcomes: [],
        refusedReason:
          "a purge entered inside a session append-lock hold would delete rows outside the " +
          "hold's serialization; refusing to delete any row.",
      };
    }

    const outcomes: SessionPurgeOutcome[] = [];
    for (const sessionId of sessionIds) {
      outcomes.push(await this.#purgeSession(sessionId));
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
    const failures: string[] = [];
    if (removedSessions.length > 0) {
      try {
        await this.#appendReceipt(operationId, purgeInstant, removedSessions);
      } catch (error) {
        failures.push(
          `purge receipt append failed after rows of ${String(removedSessions.length)} sessions were deleted: ${describeError(error)}`,
        );
      }
      const checkpointFailure: string | undefined = this.#truncateWriteAheadLog();
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

  async #purgeSession(sessionId: SessionId): Promise<SessionPurgeOutcome> {
    try {
      return await withSessionAppendLock(sessionId, () =>
        Promise.resolve(this.#deleteSessionRows(sessionId)),
      );
    } catch (error) {
      return { sessionId, rowsDeleted: 0, refusedReason: describeError(error) };
    }
  }

  // One transaction: the range read, the snapshots and the events commit or roll back together.
  #deleteSessionRows(sessionId: SessionId): SessionPurgeOutcome {
    return this.#db.transaction((): SessionPurgeOutcome => {
      const range = this.#rangeStmt.get(sessionId) as PurgeRangeRow;
      this.#deleteSnapshotsStmt.run(sessionId);
      const rowsDeleted: number = this.#deleteEventsStmt.run(sessionId).changes;
      if (rowsDeleted === 0) {
        return { sessionId, rowsDeleted };
      }
      return {
        sessionId,
        rowsDeleted,
        fromSequence: readNumber(range.fromSequence, "first deleted sequence"),
        toSequence: readNumber(range.toSequence, "last deleted sequence"),
      };
    })();
  }

  /** Returns why the log could not be truncated, or undefined once it was. */
  #truncateWriteAheadLog(): string | undefined {
    const rows = this.#db.pragma("wal_checkpoint(TRUNCATE)") as readonly WalCheckpointRow[];
    if (rows[0]?.busy === 0) {
      return undefined;
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A finite number, accepting a `bigint` only when it is a safe integer: past 2^53 the nearest
 * double names a different row and would put a wrong range into the receipt.
 */
function readNumber(value: unknown, column: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") {
    const narrowed: number = Number(value);
    if (Number.isSafeInteger(narrowed)) return narrowed;
    throw new SessionPurgeRefusal(
      `${column} is a bigint past the safe-integer range (${String(value)}); refusing to narrow ` +
        "it, because the nearest double names a different row than the one stored.",
    );
  }
  throw new SessionPurgeRefusal(
    `${column} is not a finite INTEGER (got ${typeof value}); the stored row is corrupt.`,
  );
}
