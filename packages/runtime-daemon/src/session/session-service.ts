// SessionService — durable append + replay over Local SQLite.
//
// Append path (Plan-001 owned):
//   - Writes one `session_events` row per event. Single-statement
//     INSERT is implicitly atomic in SQLite; Plan-006 will introduce a
//     `db.transaction(...)` wrapper once snapshot writes land alongside
//     event writes (so the row + snapshot commit as a unit).
//   - Materializes hash-chain placeholder bytes (zero-fill) so the NOT
//     NULL constraints in the schema are satisfied without claiming
//     Plan-006 hash-chain semantics. Plan-006 (Session Event Taxonomy +
//     Audit Log) replaces this with real BLAKE3 + Ed25519 over RFC 8785
//     JCS-canonical bytes.
//   - Materializes `monotonic_ns` from the writer (caller-supplied) so
//     tests can drive non-monotonic values to exercise D3.
//   - Writes `pii_payload = NULL` always — no V1 SessionEvent variant
//     carries PII per Spec-022 §PII Data Map. Plan-022 owns the wrapping
//     pipeline that populates this column for sensitive event variants.
//
// Replay path (Plan-001 owned):
//   - Reads events for a session by `sequence ASC` — the canonical replay
//     key per ADR-017 §Decision and local-sqlite-schema.md §session_events.
//   - Returns hydrated `StoredEvent` objects (parsed JSON payload). The
//     projector consumes these to build `DaemonSessionSnapshot`.
//   - `monotonic_ns` is hydrated as `bigint` (SQLite INTEGER → JS Number
//     loses precision above 2^53 — process.hrtime.bigint() can produce
//     values above this — so better-sqlite3's `safeIntegers` mode is
//     enabled per-statement on the read path).
//
// What this service does NOT do (deferred):
//   - Snapshot persistence to `session_snapshots`. D4 proves replay
//     reproducibility from the event log alone; snapshot caching is a
//     read-perf optimization Plan-001 reserves for later in the slice
//     and that Plan-006 (BL-050 hash-chain integrity) and Plan-015
//     (replay cursors) refine.
//   - Real hash-chain or signature material. See top-of-file note.
//   - Recovery from torn writes mid-batch. Plan-015 owns recovery.

import type { Database, RunResult, Statement } from "better-sqlite3";

import type { AppendableEvent, DaemonSessionSnapshot, StoredEvent } from "./types.js";
import { replay as projectReplay } from "./session-projector.js";

// Hash-chain placeholder bytes — see migrations/0001-initial.sql header
// for the full forward-declaration rationale.
const HASH_PLACEHOLDER_LEN: number = 32;
const SIG_PLACEHOLDER_LEN: number = 64;
const ZERO_HASH: Buffer = Buffer.alloc(HASH_PLACEHOLDER_LEN);
const ZERO_SIGNATURE: Buffer = Buffer.alloc(SIG_PLACEHOLDER_LEN);

// Internal row shape returned by better-sqlite3's `.all()` on the read
// query. Kept private — callers receive `StoredEvent` (with parsed JSON
// payload + bigint monotonic_ns).
interface SessionEventRow {
  readonly id: string;
  readonly session_id: string;
  readonly sequence: number | bigint;
  readonly occurred_at: string;
  readonly monotonic_ns: bigint; // safeIntegers=true on read statement
  readonly category: string;
  readonly type: string;
  readonly actor: string | null;
  readonly payload: string;
  readonly correlation_id: string | null;
  readonly causation_id: string | null;
  readonly version: string;
}

export class SessionService {
  // The Database handle itself is not held — better-sqlite3's prepared
  // statements internally reference their parent DB, so the statements
  // alone are sufficient to keep the connection alive for the lifetime
  // of this service instance.
  readonly #insertStmt: Statement;
  readonly #replayStmt: Statement;

  constructor(db: Database) {
    this.#insertStmt = db.prepare(
      `INSERT INTO session_events (
         id, session_id, sequence, occurred_at, monotonic_ns,
         category, type, actor, payload, pii_payload,
         correlation_id, causation_id, version,
         prev_hash, row_hash, daemon_signature, participant_signature
       ) VALUES (
         @id, @session_id, @sequence, @occurred_at, @monotonic_ns,
         @category, @type, @actor, @payload, NULL,
         @correlation_id, @causation_id, @version,
         @prev_hash, @row_hash, @daemon_signature, NULL
       )`,
    );
    this.#replayStmt = db
      .prepare(
        `SELECT id, session_id, sequence, occurred_at, monotonic_ns,
                category, type, actor, payload,
                correlation_id, causation_id, version
         FROM session_events
         WHERE session_id = ?
         ORDER BY sequence ASC`,
      )
      // Force bigint on numeric columns so monotonic_ns above 2^53 round-
      // trips losslessly. better-sqlite3's `safeIntegers` is per-statement.
      .safeIntegers(true);
  }

  /**
   * Append one event to the session log. Synchronous — better-sqlite3
   * is fully synchronous by design. Throws on UNIQUE(session_id,
   * sequence) violations (the caller must coordinate sequence assignment).
   */
  append(event: AppendableEvent): void {
    const result: RunResult = this.#insertStmt.run({
      id: event.id,
      session_id: event.sessionId,
      sequence: event.sequence,
      occurred_at: event.occurredAt,
      monotonic_ns: event.monotonicNs,
      category: event.category,
      type: event.type,
      actor: event.actor,
      payload: JSON.stringify(event.payload),
      correlation_id: event.correlationId,
      causation_id: event.causationId,
      version: event.version,
      prev_hash: ZERO_HASH,
      row_hash: ZERO_HASH,
      daemon_signature: ZERO_SIGNATURE,
    });
    if (result.changes !== 1) {
      throw new Error(
        `SessionService.append: expected 1 row inserted, got ${String(result.changes)} for session=${event.sessionId} sequence=${String(event.sequence)}`,
      );
    }
  }

  /**
   * Read all events for a session, ordered by `sequence ASC`. Returns
   * `[]` for unknown sessions.
   */
  readEvents(sessionId: string): ReadonlyArray<StoredEvent> {
    const rows: ReadonlyArray<SessionEventRow> = this.#replayStmt.all(sessionId) as ReadonlyArray<SessionEventRow>;
    return rows.map((row) => hydrateRow(row));
  }

  /**
   * Convenience: replay a session straight to its snapshot. Returns
   * `null` if the session has no events.
   */
  replay(sessionId: string): DaemonSessionSnapshot | null {
    return projectReplay(this.readEvents(sessionId));
  }
}

// --------------------------------------------------------------------------
// Row hydration
// --------------------------------------------------------------------------

function hydrateRow(row: SessionEventRow): StoredEvent {
  // safeIntegers=true returns bigints for ALL integer columns; sequence
  // is always small enough to fit in a Number, but monotonic_ns is not.
  // Convert sequence back to Number for type compatibility with the
  // `StoredEvent.sequence: number` field; preserve monotonic_ns as bigint.
  const sequence: number = typeof row.sequence === "bigint" ? Number(row.sequence) : row.sequence;
  const payload: Record<string, unknown> = JSON.parse(row.payload) as Record<string, unknown>;
  return {
    id: row.id,
    sessionId: row.session_id,
    sequence,
    occurredAt: row.occurred_at,
    monotonicNs: row.monotonic_ns,
    category: row.category,
    type: row.type,
    actor: row.actor,
    payload,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    version: row.version,
  };
}
