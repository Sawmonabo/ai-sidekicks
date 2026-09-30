// The whole-session purge: one deletion replaces every purgeable row of each
// session it removes with an audit stub, so the sessions' content is gone and
// their rows' skeleton survives, and appends one receipt naming every session
// it removed.
//
// This is the only operation in this package that MUTATES an already-committed
// row of the append-only log, and it runs only when a person deletes sessions.
// Nothing in the background calls it: a kept session's transcript is never
// thinned, and the background compactor never rewrites a committed column. The
// caller chooses the sessions and owns the precondition that each is archived or
// closed and locked against new work while the purge runs; this module does not
// read session state.
//
// Two properties carry the design:
//
//   1. NEVER-PURGED CATEGORY. The row selector excludes `event_maintenance` in
//      SQL, so a row of that family is never read as a candidate:
//      `event_maintenance` rows record maintenance, this purge's own receipt
//      included.
//   2. STORE-CANONICAL-BYTES. The stub projection is canonicalized ONCE to `B`
//      under `EVENT_CANONICAL_BYTES_MAX`, and `B` is what lands in `payload`, so
//      the stored stub is canonical JSON within the relay-frame bound.
//
// `payload` is a TEXT-affinity column and `B` is a `Uint8Array`. Binding `B` as
// a Buffer would write a BLOB into that column. The binding is therefore
// `new TextDecoder().decode(B)`: canonical JSON is valid UTF-8, so the decode is
// lossless. The decoded string is derived from `B` and never from a second
// `JSON.stringify`.
//
// Before anything is destroyed, the purge checks it is NOT INSIDE AN
// APPEND-LOCK HOLD, once per deletion. The session append lock is reentrant per
// owner, so a purge entered inside a hold would acquire nothing for the rows it
// stubs and run outside the serialization the hold provides.
//
// A session that is refused does not stop the deletion: the others are
// independent, and the person asked for all of them to go. The receipt names
// each session that lost rows, with the range it stubbed; a session refused
// before its first stub lost nothing and is not named, and one that stopped part
// way is named with the range it did stub. Each refusal is on that session's
// outcome.
//
// Locking. Each row is read, projected and rewritten under one hold of its
// session's append lock; the receipt is appended after every session, outside
// every hold: the append takes its own lock, and a hold spanning async work
// would stall every producer on the session.

import {
  CONTENT_LENGTH_PAYLOAD_KEY,
  CONTENT_TRUNCATED_PAYLOAD_KEY,
  DAEMON_SCOPE_SENTINEL_SESSION_ID,
  EVENT_CANONICAL_BYTES_MAX,
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
import type { SessionContentKeyDisposer } from "./session-content-key-store.js";
import { mintUuidV7 } from "../ids/uuid-v7.js";

/** The `retention_class` value a purged row carries. */
export const AUDIT_STUB_RETENTION_CLASS = "audit_stub" as const;

/** The category a purge never touches: maintenance records, its own receipt included. */
const NEVER_PURGED_EVENT_CATEGORIES: readonly EventCategory[] = ["event_maintenance"];

// The same categories as a SQL literal list, interpolated rather than bound:
// positional binds would tie each statement's correctness to where the shared
// WHERE fragment sits in it. `EventCategory` is a closed union of bare
// identifiers, so there is nothing to escape. Derived from the array so the two
// cannot drift.
const NEVER_PURGED_CATEGORY_SQL_LIST: string = NEVER_PURGED_EVENT_CATEGORIES.map(
  (category) => `'${category}'`,
).join(", ");

// A row that is neither already a stub nor in a never-purged category.
const LIVE_PURGEABLE_WHERE = `retention_class IS NULL
           AND category NOT IN (${NEVER_PURGED_CATEGORY_SQL_LIST})`;

/**
 * Payload members kept VERBATIM in the stub whenever the source payload carries
 * them.
 *
 *   * `runId` + `runVersion`: the terminal-run unique index's expressions on
 *     terminal `run_lifecycle` rows. `trg_run_terminal_key_update` aborts a stub
 *     that drops, retypes or alters either, and dropping them would let a second
 *     terminal for the same run land.
 *   * `executionPosture` + `credentialPolicyRef`: the posture audit record on
 *     `run.running` rows. A trusted-mode row carries no credential reference and
 *     the stub neither requires nor invents one.
 *   * `targetPosition`: the rewind target on `run.rolled_back` rows.
 *   * `sourceEpoch` + `sourcePosition`: the epoch stamp, so a stub of a
 *     stale-epoch row stays attributed to its source epoch.
 *   * `contentLength` + `contentTruncated`: the shape of the sealed body the
 *     same UPDATE destroys.
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

// The receipt's envelope category, type and version. The version is minted
// through its schema so a literal that stopped satisfying the grammar throws at
// import rather than at the first receipt.
const EVENT_MAINTENANCE_CATEGORY: EventCategory = "event_maintenance";
const PURGE_RECEIPT_TYPE = "event.compacted" as const;
const PURGE_RECEIPT_VERSION: EventEnvelopeVersion = EventEnvelopeVersionSchema.parse("1.0");

/**
 * The stub projection that replaces a purged row's `payload`.
 *
 * The index signature carries the preserved members, which are written under
 * keys known only at run time. `purgedAt` and `summary` exist only inside these
 * bytes and have no scalar column; every other named member mirrors its column.
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
   * Present iff this session was refused or its content key could not be
   * retired. A refusal raised among its rows leaves the rows already stubbed as
   * stubs, and the receipt names exactly those.
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
   * Present iff the deletion as a whole was refused or failed: before any
   * session was touched (the lock-hold check; `outcomes` is then empty), or
   * when the receipt could not be appended after rows were stubbed.
   */
  readonly refusedReason?: string | undefined;
}

/**
 * The durable append seam for the receipt. Structural, so a test can hand in a
 * recording double.
 */
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
  /**
   * Retires the session's wrapped content key once the purge has cleared the
   * last body it sealed. Required: a no-op default would leave dead wrapped
   * keys accumulating with nothing at the wiring site to say so.
   */
  readonly contentKeyDisposer: SessionContentKeyDisposer;
  /** One clock for the stub's `purgedAt` and the receipt's timestamps. */
  readonly now?: () => Date;
  /** Mints the receipt's `operationId`. Defaults to `mintUuidV7`. */
  readonly operationIdFactory?: () => string;
  /** Mints the receipt row's id. Defaults to `mintUuidV7`. */
  readonly newEventId?: () => string;
}

// Raw read shapes. Every member is `unknown` because column declarations are
// claims TypeScript never checked, and the read boundary is where they are
// checked.
interface CandidateRow {
  readonly id: unknown;
  readonly sequence: unknown;
  readonly occurred_at: unknown;
  readonly category: unknown;
  readonly type: unknown;
  readonly actor: unknown;
  readonly payload: unknown;
}

// Thrown to abort one session or the whole deletion. Caught in `purge` and turned
// into a `refusedReason`; never escapes it.
class SessionPurgeRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionPurgeRefusal";
  }
}

/**
 * Purges the sessions one deletion removes.
 *
 * Rows commit one per hold, not in one transaction: each row's replace and
 * mark is a single UPDATE and so atomic, and a transaction across every row
 * would hold the session's lock for the whole purge. A purge that stops part
 * way leaves a mixed session, each row either whole or a stub, and a
 * repeated purge resumes it: the `retention_class IS NULL` filter skips the
 * rows already stubbed.
 */
export class SessionPurge {
  readonly #nodeId: NodeId;
  readonly #eventLog: SessionPurgeEventLog;
  readonly #contentKeyDisposer: SessionContentKeyDisposer;
  readonly #now: () => Date;
  readonly #operationIdFactory: () => string;
  readonly #newEventId: () => string;

  // Prepared in the constructor: every statement names `retention_class`, so a
  // handle that never ran the migration adding it fails at construction.
  readonly #candidateSequencesStmt: Statement;
  readonly #candidateRowStmt: Statement;
  readonly #stubUpdateStmt: Statement;

  constructor(deps: SessionPurgeDeps) {
    this.#nodeId = deps.nodeId;
    this.#eventLog = deps.eventLog;
    this.#contentKeyDisposer = deps.contentKeyDisposer;
    this.#now = deps.now ?? ((): Date => new Date());
    this.#operationIdFactory = deps.operationIdFactory ?? mintUuidV7;
    this.#newEventId = deps.newEventId ?? mintUuidV7;

    // Sequences only: each row is re-read under its own hold, so the projection
    // is built from state observed inside the hold.
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

    // The destruction. `payload` is rewritten, never nulled (the column is NOT
    // NULL and a reader must still find the stub). The PII ciphertext, its owner
    // stamp and the sealed body go, and so do the correlation links. Left out,
    // and load-bearing that they are: `monotonic_ns` and `version`, and
    // `category` / `type`, which the terminal-key trigger's de-scope leg
    // watches and the stub mirrors. The `retention_class IS NULL` guard makes a
    // repeated UPDATE a zero-row no-op rather than a double stub.
    this.#stubUpdateStmt = deps.db.prepare(
      `UPDATE session_events
          SET payload = ?,
              correlation_id = NULL,
              causation_id = NULL,
              pii_payload = NULL,
              pii_user_id = NULL,
              content_payload = NULL,
              retention_class = ?
        WHERE id = ?
          AND session_id = ?
          AND retention_class IS NULL`,
    );
  }

  /**
   * Replace every live purgeable row of each session in `sessionIds` with an
   * audit stub, append one receipt naming every session that lost rows,
   * and retire each such session's content key.
   *
   * Never throws: every failure becomes a `refusedReason`, on the session it
   * belongs to or on the deletion.
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

    // The receipt names every session that lost rows, INCLUDING one that was
    // refused part way: that is exactly where rows were destroyed, and
    // destruction must never go unrecorded.
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

    // The stub UPDATE is a `content_payload = NULL` writer, so the purge may
    // have cleared the last body a session's wrapped key sealed. The store
    // re-checks under its own exclusion and is a no-op while any body survives.
    // A failure here is reported, and it is a delay rather than a leak: the
    // compactor's tick sweeps every unreferenced key.
    const settledOutcomes: SessionPurgeOutcome[] = [];
    for (const outcome of outcomes) {
      settledOutcomes.push(
        outcome.rowsStubbed > 0 ? await this.#disposeContentKey(outcome) : outcome,
      );
    }

    return { operationId, outcomes: settledOutcomes, refusedReason };
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

  async #disposeContentKey(outcome: SessionPurgeOutcome): Promise<SessionPurgeOutcome> {
    try {
      await this.#contentKeyDisposer.deleteIfUnreferenced(outcome.sessionId);
      return outcome;
    } catch (error) {
      const disposalFailure = `session content-key disposal failed after ${String(outcome.rowsStubbed)} rows were stubbed: ${describeError(error)}`;
      return { ...outcome, refusedReason: appendReason(outcome.refusedReason, disposalFailure) };
    }
  }

  /**
   * One hold on the session's append lock, spanning read, project, canonicalize
   * and UPDATE. Returns false when the row was no longer live under the
   * hold (a concurrent purge stubbed it).
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
      // Measured off the STORED text: this figure goes into the summary, and a
      // re-serialization would disagree by whatever key order and whitespace the
      // original write used.
      const storedPayloadByteLength: number = Buffer.byteLength(storedPayload, "utf8");
      const projection: AuditStubProjection = projectAuditStub(
        sessionId,
        row,
        eventId,
        parsePayload(storedPayload, eventId),
        storedPayloadByteLength,
        purgeInstant,
      );

      // STORE-CANONICAL-BYTES. The UPDATE stores the UTF-8 decoding of the
      // bounded canonicalization's output. The decode is sound because
      // `canonicalizeJson` refuses a lone surrogate; without that guard the
      // decoder would substitute U+FFFD.
      const canonicalStubBytes: CanonicalBytes = canonicalizeBoundedStubProjection(
        projection,
        eventId,
      );

      const result = this.#stubUpdateStmt.run(
        new TextDecoder().decode(canonicalStubBytes),
        AUDIT_STUB_RETENTION_CLASS,
        eventId,
        sessionId,
      );
      if (result.changes !== 1) {
        // Under this hold the row was just read live, so a miss means it moved
        // inside the critical section. Counting it as stubbed would report a row
        // that still holds its full payload.
        throw new SessionPurgeRefusal(
          `audit-stub UPDATE for event ${eventId} (sequence ${String(sequence)}) changed ` +
            `${String(result.changes)} rows, expected 1.`,
        );
      }
      return true;
    });
  }

  /**
   * One receipt per deletion, appended on the daemon-scope sentinel and naming
   * every session the deletion removed rows from.
   *
   * Each range bounds the rows actually stubbed: after a refusal part way the
   * session's tail still holds full payloads. Never-purged
   * rows can sit inside a range; a reader that needs per-row truth reads
   * `retention_class`. Parsed at the emission seam, so a drifted shape fails
   * here rather than reaching the append.
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
  // PARSED, not cast: the category is written into the stub, and a column value
  // outside the enum would be frozen there by the one operation that destroys
  // the evidence of how it got there.
  const category: EventCategory = EventCategorySchema.parse(
    readString(row.category, "session_events.category"),
  );
  const type: string = readString(row.type, "session_events.type");

  const projection: AuditStubProjection = {
    // Each scalar member is taken from the stored row, so the stub mirrors its
    // columns exactly.
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
 * A one-line summary composed from the row's SHAPE (category, type, field
 * count, byte count) and never from payload values: the stub carries no PII,
 * and interpolating payload content would put it back into bytes kept for the
 * life of the log.
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

/**
 * Canonicalize a stub projection under `EVENT_CANONICAL_BYTES_MAX`, shortening
 * the locally minted `summary` toward the bound and refusing when the projection
 * stays oversized with `summary` gone.
 *
 * It can fire because this module reads rows straight off SQLite, including
 * rows written outside the append path's ceiling, and the preserved members are
 * copied verbatim. `summary` is the one member minted here, so it is the one a
 * bound may shorten; the rest are scalar mirrors or preserved evidence.
 *
 * Measured on canonical bytes and cut by code points: every code point
 * serializes to at least one byte, so each round removes at least the overage
 * and the loop converges, and cutting by code point never splits a surrogate
 * pair, which `canonicalizeJson` would refuse.
 */
function canonicalizeBoundedStubProjection(
  projection: AuditStubProjection,
  eventId: string,
): CanonicalBytes {
  let boundedProjection: AuditStubProjection = projection;
  let canonicalStubBytes: CanonicalBytes = canonicalizeJson(boundedProjection);
  while (
    canonicalStubBytes.length > EVENT_CANONICAL_BYTES_MAX &&
    boundedProjection.summary.length > 0
  ) {
    const overage: number = canonicalStubBytes.length - EVENT_CANONICAL_BYTES_MAX;
    const summaryCodePoints: readonly string[] = Array.from(boundedProjection.summary);
    boundedProjection = {
      ...boundedProjection,
      summary: summaryCodePoints.slice(0, Math.max(0, summaryCodePoints.length - overage)).join(""),
    };
    canonicalStubBytes = canonicalizeJson(boundedProjection);
  }
  if (canonicalStubBytes.length > EVENT_CANONICAL_BYTES_MAX) {
    throw new SessionPurgeRefusal(
      `audit-stub projection for event ${eventId} is ${String(canonicalStubBytes.length)} ` +
        `canonical bytes with its summary already emptied, over the ` +
        `${String(EVENT_CANONICAL_BYTES_MAX)}-byte EVENT_CANONICAL_BYTES_MAX bound every ` +
        "stored payload must satisfy; every remaining member is a scalar mirror or preserved " +
        "content this purge may not shorten.",
    );
  }
  return canonicalStubBytes;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// A later failure keeps the earlier cause, because the first explains why the
// session's purge stopped where it did.
function appendReason(existing: string | undefined, next: string): string {
  return existing === undefined ? next : `${existing}; ${next}`;
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
 * A finite number, accepting a `bigint` only when it round-trips as a safe
 * integer: past 2^53 the nearest double names a different row, and a byte count
 * would be written wrong into a stub kept for the life of the log.
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
