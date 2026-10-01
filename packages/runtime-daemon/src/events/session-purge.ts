// The whole-session purge: replaces every purgeable row of each session a person deletes with an
// audit stub, so the content is gone and the row skeleton survives, then appends one receipt
// naming every session that lost rows.
//
// It is the only operation in this package that mutates a committed row of the append-only log.
// Nothing in the background calls it. The caller chooses the sessions and owns the precondition
// that each is archived or closed and locked against new work while the purge runs; this module
// does not read session state.
//
//   - `event_maintenance` rows are never purged: the selector excludes them in SQL, and they
//     record maintenance, this purge's own receipt included.
//   - The stub projection is canonicalized once to `B`, and `B` is what lands in `payload`, so the
//     stored stub is canonical JSON. `payload` is a TEXT-affinity column, and binding a Buffer
//     would write a BLOB, so `B` is bound as `new TextDecoder().decode(B)`. The decode is lossless because canonical JSON is valid UTF-8,
//     and the string comes from `B`, never from a second `JSON.stringify`.
//   - The purge refuses to start inside an append-lock hold. The lock is reentrant per owner, so a
//     purge entered inside a hold would stub rows outside the serialization the hold provides.
//   - A refused session does not stop the deletion; the others are independent. The receipt names
//     each session that lost rows with the range it stubbed, including one that stopped part way;
//     a session refused before its first stub lost nothing and is not named. Each refusal is on
//     that session's outcome.
//   - Each row is read, projected and rewritten under one hold of its session's append lock. The
//     receipt is appended after every session, outside every hold, because the append takes its
//     own lock and a hold spanning async work would stall every producer on the session.

import {
  CONTENT_LENGTH_PAYLOAD_KEY,
  CONTENT_TRUNCATED_PAYLOAD_KEY,
  DAEMON_SCOPE_SENTINEL_SESSION_ID,
  EventCategorySchema,
  EventCompactedPayloadSchema,
  EventEnvelopeVersionSchema,
  SOURCE_EPOCH_PAYLOAD_KEY,
  SOURCE_POSITION_PAYLOAD_KEY,
} from "@ai-sidekicks/contracts";
import type {
  EventCategory,
  EventCompactedPayload,
  EventCompactedRemovedSession,
  EventEnvelopeVersion,
  NodeId,
  SessionId,
} from "@ai-sidekicks/contracts";
import type { Database, Statement } from "better-sqlite3";

import { canonicalizeJson } from "./canonicalizer.js";
import type { CanonicalBytes } from "./canonicalizer.js";
import type {
  EventLogAppendOptions,
  EventLogAppendReceipt,
  UnsequencedEventEnvelope,
} from "./event-log-service.js";
import { isWithinSessionAppendLockHold, withSessionAppendLock } from "./session-append-lock.js";
import { mintUuidV7 } from "../ids/uuid-v7.js";

/** The `retention_class` value a purged row carries. */
export const AUDIT_STUB_RETENTION_CLASS = "audit_stub" as const;

/** The category a purge never touches: maintenance records, its own receipt included. */
const NEVER_PURGED_EVENT_CATEGORIES: readonly EventCategory[] = ["event_maintenance"];

// The same categories as a SQL literal list, interpolated rather than bound, so no statement's
// correctness depends on where the shared WHERE fragment sits among positional binds.
// `EventCategory` is a closed union of bare identifiers, so nothing needs escaping. Derived from
// the array so the two cannot drift.
const NEVER_PURGED_CATEGORY_SQL_LIST: string = NEVER_PURGED_EVENT_CATEGORIES.map(
  (category) => `'${category}'`,
).join(", ");

// A row that is neither already a stub nor in a never-purged category.
const LIVE_PURGEABLE_WHERE = `retention_class IS NULL
           AND category NOT IN (${NEVER_PURGED_CATEGORY_SQL_LIST})`;

/**
 * Payload members kept verbatim in the stub whenever the source payload carries them:
 *   - `runId` + `runVersion`: the terminal-run unique index's expressions on terminal
 *     `run_lifecycle` rows. `trg_run_terminal_key_update` aborts a stub that drops, retypes or
 *     alters either, and dropping them would let a second terminal for the same run land.
 *   - `executionPosture` + `credentialPolicyRef`: the posture record on `run.running` rows. A
 *     trusted-mode row carries no credential reference, and the stub neither requires nor invents
 *     one.
 *   - `targetPosition`: the rewind target on `run.rolled_back` rows.
 *   - `sourceEpoch` + `sourcePosition`: the epoch stamp, so the stub of a stale-epoch row stays
 *     attributed to its source epoch.
 *   - `contentLength` + `contentTruncated`: the shape of the body the same UPDATE destroys.
 */
const PRESERVED_PAYLOAD_KEYS: readonly string[] = [
  "runId",
  "runVersion",
  "executionPosture",
  "credentialPolicyRef",
  "targetPosition",
  SOURCE_EPOCH_PAYLOAD_KEY,
  SOURCE_POSITION_PAYLOAD_KEY,
  CONTENT_LENGTH_PAYLOAD_KEY,
  CONTENT_TRUNCATED_PAYLOAD_KEY,
];

// The receipt's envelope category, type and version. The version is parsed through its schema, so
// a literal that stops satisfying the grammar throws at import rather than at the first receipt.
const EVENT_MAINTENANCE_CATEGORY: EventCategory = "event_maintenance";
const PURGE_RECEIPT_TYPE = "event.compacted" as const;
const PURGE_RECEIPT_VERSION: EventEnvelopeVersion = EventEnvelopeVersionSchema.parse("1.0");

/**
 * The stub projection that replaces a purged row's `payload`. The index signature carries the
 * preserved members, written under keys known only at run time. `purgedAt` and `summary` exist
 * only inside these bytes; every other named member mirrors its column.
 */
type AuditStubProjection = {
  id: string;
  sessionId: SessionId;
  sequence: number;
  occurredAt: string;
  category: EventCategory;
  type: string;
  actor: string | null;
  purgedAt: string;
  retentionClass: typeof AUDIT_STUB_RETENTION_CLASS;
  summary: string;
  [preservedKey: string]: unknown;
};

/** What one deletion did to one of its sessions, or refused to do and why. */
export interface SessionPurgeOutcome {
  readonly sessionId: SessionId;
  /** Rows whose payload was replaced by an audit stub. */
  readonly rowsStubbed: number;
  /** The lowest and highest sequence stubbed; absent when no row was. */
  readonly fromSequence?: number | undefined;
  readonly toSequence?: number | undefined;
  /**
   * Present iff this session was refused. A refusal among its rows leaves the rows already
   * stubbed as stubs, and the receipt names exactly those.
   */
  readonly refusedReason?: string | undefined;
}

/** What one deletion did. */
export interface SessionPurgeResult {
  /** The receipt's `operationId`. */
  readonly operationId: string;
  /** One entry per session the deletion was asked to remove, in order. */
  readonly outcomes: readonly SessionPurgeOutcome[];
  /**
   * Present iff the deletion as a whole was refused or failed: before any session was touched
   * (the lock-hold check; `outcomes` is then empty), or when the receipt could not be appended
   * after rows were stubbed.
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
  /** The connection every read and stub UPDATE lands on. */
  readonly db: Database;
  /** This daemon's NodeId, attributed in every receipt. */
  readonly nodeId: NodeId;
  /** Where the receipt is appended. */
  readonly eventLog: SessionPurgeEventLog;
  /** One clock for the stub's `purgedAt` and the receipt's timestamps. */
  readonly now?: () => Date;
  /** Mints the receipt's `operationId`. Defaults to `mintUuidV7`. */
  readonly operationIdFactory?: () => string;
  /** Mints the receipt row's id. Defaults to `mintUuidV7`. */
  readonly newEventId?: () => string;
}

// Raw read shapes. Every member is `unknown` because column types are claims TypeScript never
// checked; the read boundary is where they are checked.
interface CandidateRow {
  readonly id: unknown;
  readonly sequence: unknown;
  readonly occurred_at: unknown;
  readonly category: unknown;
  readonly type: unknown;
  readonly actor: unknown;
  readonly payload: unknown;
}

// Thrown to abort one session or the whole deletion. Caught in `purge` and turned into a
// `refusedReason`; never escapes it.
class SessionPurgeRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionPurgeRefusal";
  }
}

/**
 * Purges the sessions one deletion removes.
 *
 * Rows commit one per hold, not in one transaction: each row's replace-and-mark is a single atomic
 * UPDATE, and a transaction across every row would hold the session's lock for the whole purge. A
 * purge that stops part way leaves a mixed session, each row either whole or a stub, and a repeated
 * purge resumes it because the `retention_class IS NULL` filter skips rows already stubbed.
 */
export class SessionPurge {
  readonly #nodeId: NodeId;
  readonly #eventLog: SessionPurgeEventLog;
  readonly #now: () => Date;
  readonly #operationIdFactory: () => string;
  readonly #newEventId: () => string;

  // Prepared in the constructor: every statement names `retention_class`, so a handle without
  // that column fails at construction.
  readonly #candidateSequencesStmt: Statement;
  readonly #candidateRowStmt: Statement;
  readonly #stubUpdateStmt: Statement;

  constructor(deps: SessionPurgeDeps) {
    this.#nodeId = deps.nodeId;
    this.#eventLog = deps.eventLog;
    this.#now = deps.now ?? ((): Date => new Date());
    this.#operationIdFactory = deps.operationIdFactory ?? mintUuidV7;
    this.#newEventId = deps.newEventId ?? mintUuidV7;

    // Sequences only: each row is re-read under its own hold, so the projection is built from
    // state observed inside the hold.
    this.#candidateSequencesStmt = deps.db.prepare(
      `SELECT sequence AS sequence
         FROM session_events
        WHERE session_id = ?
          AND ${LIVE_PURGEABLE_WHERE}
        ORDER BY sequence`,
    );

    this.#candidateRowStmt = deps.db.prepare(
      `SELECT id AS id,
              sequence AS sequence,
              occurred_at AS occurred_at,
              category AS category,
              type AS type,
              actor AS actor,
              payload AS payload
         FROM session_events
        WHERE session_id = ?
          AND sequence = ?
          AND ${LIVE_PURGEABLE_WHERE}`,
    );

    // The destruction. `payload` is rewritten, never nulled: the column is NOT NULL and a reader
    // must still find the stub. The body and the correlation links go. `monotonic_ns`, `version`,
    // `category` and `type` stay, because the terminal-key trigger requires `category` and `type`
    // unchanged and the stub mirrors them. The `retention_class IS NULL` guard makes a repeated
    // UPDATE a zero-row no-op, not a double stub.
    this.#stubUpdateStmt = deps.db.prepare(
      `UPDATE session_events
          SET payload = ?,
              correlation_id = NULL,
              causation_id = NULL,
              content_payload = NULL,
              retention_class = ?
        WHERE id = ?
          AND session_id = ?
          AND retention_class IS NULL`,
    );
  }

  /**
   * Replaces every live purgeable row of each session in `sessionIds` with an audit stub, appends
   * one receipt naming every session that lost rows.
   *
   * Never throws: every failure becomes a `refusedReason`, on the session it belongs to or on the
   * deletion.
   */
  async purge(sessionIds: readonly SessionId[]): Promise<SessionPurgeResult> {
    const operationId: string = this.#operationIdFactory();
    const purgeInstant: Date = this.#now();

    try {
      if (isWithinSessionAppendLockHold()) {
        throw new SessionPurgeRefusal(
          "a purge entered inside a session append-lock hold would stub rows outside the hold's " +
            "serialization; refusing to mutate any row.",
        );
      }
    } catch (error) {
      return { operationId, outcomes: [], refusedReason: describeError(error) };
    }

    const outcomes: SessionPurgeOutcome[] = [];
    for (const sessionId of sessionIds) {
      outcomes.push(await this.#purgeSession(sessionId, purgeInstant));
    }

    // The receipt names every session that lost rows, including one refused part way: destruction
    // must never go unrecorded.
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
    let refusedReason: string | undefined;
    if (removedSessions.length > 0) {
      try {
        await this.#appendReceipt(operationId, purgeInstant, removedSessions);
      } catch (error) {
        refusedReason = `purge receipt append failed after rows of ${String(removedSessions.length)} sessions were stubbed: ${describeError(error)}`;
      }
    }

    return { operationId, outcomes, refusedReason };
  }

  async #purgeSession(sessionId: SessionId, purgeInstant: Date): Promise<SessionPurgeOutcome> {
    let rowsStubbed = 0;
    let fromSequence: number | undefined;
    let toSequence: number | undefined;
    try {
      for (const sequence of this.#readCandidateSequences(sessionId)) {
        if (await this.#stubRow(sessionId, sequence, purgeInstant)) {
          rowsStubbed += 1;
          fromSequence ??= sequence;
          toSequence = sequence;
        }
      }
      return { sessionId, rowsStubbed, fromSequence, toSequence };
    } catch (error) {
      return {
        sessionId,
        rowsStubbed,
        fromSequence,
        toSequence,
        refusedReason: describeError(error),
      };
    }
  }

  /**
   * One hold on the session's append lock, spanning read, project, canonicalize and UPDATE.
   * Returns false when the row was no longer live under the hold (a concurrent purge stubbed it).
   */
  async #stubRow(sessionId: SessionId, sequence: number, purgeInstant: Date): Promise<boolean> {
    return withSessionAppendLock(sessionId, async () => {
      const raw: unknown = this.#candidateRowStmt.get(sessionId, sequence);
      if (raw === undefined) {
        return false;
      }
      const row = raw as CandidateRow;

      const eventId: string = readString(row.id, "session_events.id");
      const storedPayload: string = readString(row.payload, "session_events.payload");
      // Measured off the stored text: a re-serialization would disagree by whatever key order and
      // whitespace the original write used, and this figure goes into the summary.
      const storedPayloadByteLength: number = Buffer.byteLength(storedPayload, "utf8");
      const projection: AuditStubProjection = projectAuditStub(
        sessionId,
        row,
        eventId,
        parsePayload(storedPayload, eventId),
        storedPayloadByteLength,
        purgeInstant,
      );

      // The UPDATE stores the UTF-8 decoding of the canonicalization. The decode is sound because
      // `canonicalizeJson` refuses a lone surrogate; the decoder would substitute U+FFFD.
      const canonicalStubBytes: CanonicalBytes = canonicalizeJson(projection);

      const result = this.#stubUpdateStmt.run(
        new TextDecoder().decode(canonicalStubBytes),
        AUDIT_STUB_RETENTION_CLASS,
        eventId,
        sessionId,
      );
      if (result.changes !== 1) {
        // The row was just read live under this hold, so a miss means it moved inside the critical
        // section. Counting it as stubbed would report a row that still holds its full payload.
        throw new SessionPurgeRefusal(
          `audit-stub UPDATE for event ${eventId} (sequence ${String(sequence)}) changed ` +
            `${String(result.changes)} rows, expected 1.`,
        );
      }
      return true;
    });
  }

  /**
   * Appends one receipt per deletion on the daemon-scope sentinel, naming every session the
   * deletion removed rows from.
   *
   * Each range bounds the rows actually stubbed: after a refusal part way the session's tail still
   * holds full payloads. Never-purged rows can sit inside a range; a reader that needs per-row
   * truth reads `retention_class`. The payload is parsed here, so a drifted shape fails before it
   * reaches the append.
   */
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

  #readCandidateSequences(sessionId: SessionId): readonly number[] {
    const rows: readonly unknown[] = this.#candidateSequencesStmt.all(sessionId);
    return rows.map((raw) =>
      readNumber((raw as { readonly sequence: unknown }).sequence, "candidate sequence"),
    );
  }
}

function projectAuditStub(
  sessionId: SessionId,
  row: CandidateRow,
  eventId: string,
  payloadObject: Record<string, unknown>,
  storedPayloadByteLength: number,
  purgeInstant: Date,
): AuditStubProjection {
  // Parsed, not cast: a category outside the enum would be frozen into the stub by the one
  // operation that destroys the evidence of how it got there.
  const category: EventCategory = EventCategorySchema.parse(
    readString(row.category, "session_events.category"),
  );
  const type: string = readString(row.type, "session_events.type");

  const projection: AuditStubProjection = {
    // Each scalar member comes from the stored row, so the stub mirrors its columns.
    id: eventId,
    sessionId,
    sequence: readNumber(row.sequence, "session_events.sequence"),
    occurredAt: readString(row.occurred_at, "session_events.occurred_at"),
    category,
    type,
    actor: readNullableString(row.actor, "session_events.actor"),
    purgedAt: purgeInstant.toISOString(),
    retentionClass: AUDIT_STUB_RETENTION_CLASS,
    summary: buildStubSummary(category, type, payloadObject, storedPayloadByteLength),
  };

  for (const key of PRESERVED_PAYLOAD_KEYS) {
    const value: unknown = payloadObject[key];
    if (value !== undefined) {
      projection[key] = value;
    }
  }
  return projection;
}

/**
 * A one-line summary composed from the row's shape (category, type, field count, byte count) and
 * never from payload values: interpolating payload content would put PII back into bytes kept for
 * the life of the log.
 */
function buildStubSummary(
  category: EventCategory,
  type: string,
  payloadObject: Record<string, unknown>,
  storedPayloadByteLength: number,
): string {
  const fieldCount: number = Object.keys(payloadObject).length;
  return (
    `${category}/${type}: original payload discarded at purge ` +
    `(${String(fieldCount)} fields, ${String(storedPayloadByteLength)} bytes)`
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parsePayload(storedPayload: string, eventId: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(storedPayload);
  } catch (error) {
    throw new SessionPurgeRefusal(
      `session_events.payload for event ${eventId} is not valid JSON (${describeError(error)}).`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SessionPurgeRefusal(
      `session_events.payload for event ${eventId} is not a JSON object; the stub projection ` +
        "cannot read the preserved members out of it.",
    );
  }
  return parsed as Record<string, unknown>;
}

function readString(value: unknown, column: string): string {
  if (typeof value === "string") return value;
  throw new SessionPurgeRefusal(
    `${column} is not TEXT (got ${typeof value}); the stored row is corrupt.`,
  );
}

function readNullableString(value: unknown, column: string): string | null {
  if (value === null || value === undefined) return null;
  return readString(value, column);
}

/**
 * A finite number, accepting a `bigint` only when it is a safe integer: past 2^53 the nearest
 * double names a different row and would write a wrong figure into a stub kept for the life of
 * the log.
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
