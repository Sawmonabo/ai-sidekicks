// SessionService — durable append + replay over Local SQLite.
//
// Append path (Plan-001 owned — GUARDED, test-only, 2026-07-28):
//   - `append()` refuses to run unless the service was constructed with
//     the module-private `UnsignedPlaceholderAppendToken` singleton
//     (`UnsignedPlaceholderAppendToken.forTestsOnly()`). The rows this
//     path writes carry zero-filled integrity placeholders — exactly the
//     never-signed rows Plan-006's `verifyRow` refuses fail-closed
//     (`signature_placeholder`) — so no production composition root may
//     reach it, per the `Plan-006 §T3.1 — Append-path service writing integrity columns + Plan-022 Path 1 shred callback` precondition
//     (added 2026-07-27): durable production writes belong to T3.1's
//     `EventLogService.append`, the sole durable writer. Tests seeding
//     placeholder rows opt in explicitly at construction. The read
//     paths (`readEvents` / `replay`) need no opt-in.
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

// Hash-chain placeholder bytes — see migrations/0001-initial.ts header
// for the full forward-declaration rationale.
const HASH_PLACEHOLDER_LEN: number = 32;
const SIG_PLACEHOLDER_LEN: number = 64;
const ZERO_HASH: Buffer = Buffer.alloc(HASH_PLACEHOLDER_LEN);
const ZERO_SIGNATURE: Buffer = Buffer.alloc(SIG_PLACEHOLDER_LEN);

// Internal row shape returned by better-sqlite3's `.all()` on the read
// query. Kept private — callers receive `StoredEvent` (with parsed JSON
// payload + bigint monotonic_ns).
//
// `safeIntegers(true)` on the read statement applies to ALL integer
// columns (it is a per-statement, not per-column, switch). Both
// `sequence` and `monotonic_ns` are returned as `bigint`; `sequence` is
// converted back to `number` at hydration. That conversion is safe
// because `sequence` is a per-session counter and overflowing
// `Number.MAX_SAFE_INTEGER` (~9×10^15) would take decades at any
// plausible emit rate. `monotonic_ns` stays `bigint` because
// `process.hrtime.bigint()` legitimately exceeds 2^53 even on hosts
// booted well over a year.
interface SessionEventRow {
  readonly id: string;
  readonly session_id: string;
  readonly sequence: bigint;
  readonly occurred_at: string;
  readonly monotonic_ns: bigint;
  readonly category: string;
  readonly type: string;
  readonly actor: string | null;
  readonly payload: string;
  readonly correlation_id: string | null;
  readonly causation_id: string | null;
  readonly version: string;
}

/**
 * Capability token gating `SessionService.append`'s zero-filled
 * placeholder writes (see the guard rationale in the file header).
 *
 * A boolean opt-in — even one typed as the literal `true` — is not a
 * real barrier: TypeScript narrows a `boolean` to `true` inside an
 * `if`, and `condition ? true : undefined` assigns without a cast, so
 * a configuration- or environment-derived flag could thread through
 * (PR #272 Codex round 2). What this token guarantees — and what it
 * does not (scoped in Codex round 3):
 *
 *   - COMPILE TIME: the `#brand` private field makes the type nominal —
 *     no object literal, config value, or structural lookalike is
 *     assignable to it — and the `private` constructor means the only
 *     way to obtain one is `forTestsOnly()`, a loud, grep-able act no
 *     data-driven wiring can perform.
 *   - RUNTIME: the guard compares against the module-private singleton
 *     by IDENTITY (`isGenuine`), so even an `as unknown as` cast of a
 *     forged object still throws — deserialized data can never BE this
 *     object.
 *   - OUT-OF-PACKAGE: unreachable. The token is deliberately NOT
 *     re-exported from the `session` barrel or the package root, and
 *     the package `exports` map declares only `"."`, so Node itself
 *     refuses a deep import of this module from outside the package.
 *
 * Honest limit (Codex round 3): none of the above stops IN-PACKAGE code
 * from gating a genuine `forTestsOnly()` call behind an environment
 * check — `process.env.X ? UnsignedPlaceholderAppendToken.forTestsOnly()
 * : undefined` returns the real singleton and passes `isGenuine`. The
 * token blocks data-DERIVED enablement, not code that deliberately
 * calls the factory. That residual is closed mechanically by lint:
 * `eslint.config.mjs` denies `forTestsOnly` member access in
 * `packages/runtime-daemon/src/**` outside `__tests__/`, so a
 * production call site fails `pnpm lint` (and CI). A lint-suppressed
 * bypass remains expressible — there the loud name is the review
 * signal.
 */
export class UnsignedPlaceholderAppendToken {
  static readonly #singleton: UnsignedPlaceholderAppendToken = new UnsignedPlaceholderAppendToken();

  // Nominal-typing brand: a private field is invisible to structural
  // assignability, so only instances of THIS class satisfy the type.
  readonly #brand = "unsigned-placeholder-append-test-only" as const;

  private constructor() {}

  /** The sole issuance path. TEST-ONLY — see the class doc. */
  static forTestsOnly(): UnsignedPlaceholderAppendToken {
    return UnsignedPlaceholderAppendToken.#singleton;
  }

  /** Identity check against the module-private singleton (never structural). */
  static isGenuine(candidate: UnsignedPlaceholderAppendToken | undefined): boolean {
    // The singleton identity comparison alone decides the verdict. The
    // trailing `#brand` read is a redundant assertion, NOT a second
    // check — the singleton always carries the brand, so the conjunct
    // can never flip the result. It stays because the brand field
    // exists for nominal typing and this is its one read site, keeping
    // that intent visible (and the field non-dead) where the token is
    // consumed.
    return (
      candidate !== undefined &&
      candidate === UnsignedPlaceholderAppendToken.#singleton &&
      candidate.#brand === "unsigned-placeholder-append-test-only"
    );
  }
}

// Construction options for `SessionService`.
export interface SessionServiceOptions {
  // TEST-ONLY. Permits `append()`'s zero-filled integrity placeholders
  // (see the guard rationale in the file header). Takes the nominal
  // identity-checked `UnsignedPlaceholderAppendToken` — not a boolean —
  // so the opt-in can never be MANUFACTURED from data: no config value,
  // env string, or deserialized object is the singleton. Obtaining it
  // requires a literal `forTestsOnly()` call, which lint denies outside
  // `__tests__/` (see the token's class doc for the exact guarantee
  // boundary — an env-keyed guard around a genuine factory call is
  // in-package code, stopped by the lint gate, not by the type).
  // Production composition roots construct WITHOUT options and get a
  // read-only service (`readEvents`/`replay`).
  readonly allowUnsignedPlaceholderAppend?: UnsignedPlaceholderAppendToken;
}

export class SessionService {
  // The Database handle itself is not held — better-sqlite3's prepared
  // statements internally reference their parent DB, so the statements
  // alone are sufficient to keep the connection alive for the lifetime
  // of this service instance.
  readonly #insertStmt: Statement;
  readonly #replayStmt: Statement;
  readonly #allowUnsignedPlaceholderAppend: boolean;

  constructor(db: Database, options?: SessionServiceOptions) {
    // IDENTITY check against the module-private singleton — a forged or
    // deserialized object (even one cast to the token type) never passes.
    this.#allowUnsignedPlaceholderAppend = UnsignedPlaceholderAppendToken.isGenuine(
      options?.allowUnsignedPlaceholderAppend,
    );
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
   *
   * GUARDED (the `Plan-006 §T3.1 — Append-path service writing integrity columns + Plan-022 Path 1 shred callback` precondition): throws unless the
   * service was constructed with the genuine
   * `UnsignedPlaceholderAppendToken` — see the file header, the token's
   * class doc, and `SessionServiceOptions`.
   *
   * Returns `undefined` (not `void`) to satisfy the synchronous-
   * transactional `SessionEventLog` seam in `node-event-emitter.ts`,
   * whose `undefined` return type rejects Promise-returning
   * implementations at compile time.
   */
  append(event: AppendableEvent): undefined {
    if (!this.#allowUnsignedPlaceholderAppend) {
      throw new Error(
        "SessionService.append is guarded: it writes zero-filled prev_hash / row_hash / " +
          "daemon_signature placeholders, which integrity verification refuses fail-closed " +
          "(failureMode signature_placeholder). Durable production writes belong to Plan-006 " +
          "T3.1's EventLogService.append. Tests seeding placeholder rows opt in explicitly " +
          "with the identity-checked capability token: new SessionService(db, " +
          "{ allowUnsignedPlaceholderAppend: UnsignedPlaceholderAppendToken.forTestsOnly() }).",
      );
    }
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
    const rows: ReadonlyArray<SessionEventRow> = this.#replayStmt.all(
      sessionId,
    ) as ReadonlyArray<SessionEventRow>;
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
  // `safeIntegers=true` returns bigints for ALL integer columns. Convert
  // `sequence` back to Number — safe because it's a per-session counter
  // (worst-case decades to overflow Number.MAX_SAFE_INTEGER, see the
  // `SessionEventRow` block above). `monotonic_ns` stays as bigint
  // because `process.hrtime.bigint()` legitimately exceeds 2^53 even on
  // recently-booted hosts.
  const sequence: number = Number(row.sequence);
  return {
    id: row.id,
    sessionId: row.session_id,
    sequence,
    occurredAt: row.occurred_at,
    monotonicNs: row.monotonic_ns,
    category: row.category,
    type: row.type,
    actor: row.actor,
    payload: parsePayload(row),
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    version: row.version,
  };
}

// Payload parsing is the read-side trust boundary between the on-disk
// JSON blob and the projector's `Record<string, unknown>` contract. A
// defective writer that bypasses `SessionService.append()` and stores a
// non-object JSON value (array, primitive, `null`) would otherwise
// surface as a misleading downstream `TypeError` ("Cannot read
// properties of null") or projector "payload.X must be a non-empty
// string" error — both of which point to the consumer rather than the
// writer. Catching it here yields a single error site identifying the
// row and the actual shape returned, which is the right diagnostic.
//
// The wire-layer `SessionEventSchema` (packages/contracts/src/event.ts)
// constrains every V1 variant's payload to an object schema; this
// boundary mirrors that constraint at the storage seam. Plan-006
// (event-taxonomy + integrity protocol) will land a payload-
// canonicalization step that re-validates against the discriminated-
// union schema on read; until then, structural shape is what we enforce.
function parsePayload(row: SessionEventRow): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload);
  } catch (err) {
    throw new Error(
      `SessionService.hydrateRow: payload is not valid JSON for event id=${row.id} sequence=${String(row.sequence)} (${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `SessionService.hydrateRow: payload must be a JSON object for event id=${row.id} sequence=${String(row.sequence)} (got ${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed})`,
    );
  }
  return parsed as Record<string, unknown>;
}
