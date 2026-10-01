// Reads a session's events back in `sequence ASC` order and replays them to a snapshot, plus a
// guarded `append` that tests use to seed rows.
//
// `append` writes a row with a caller-chosen `sequence`, outside the per-session append lock,
// with no size ceiling. `EventLogService.append` is the only durable writer, so
// `append` refuses to run unless the service was built with `TestSeedingAppendToken`. Replay
// does not persist snapshots; it rebuilds state from the event log each time.

import type { Database, RunResult, Statement } from "better-sqlite3";

import type { DaemonSessionSnapshot, StoredEvent } from "./types.js";
import { replay as projectReplay } from "./session-projector.js";

// A row as better-sqlite3 returns it from the replay query. `safeIntegers` applies to every
// integer column of a statement, so `sequence` and `monotonic_ns` both arrive as bigint.
// `sequence` is converted back to a number at hydration (a per-session counter cannot reach
// 2^53); `monotonic_ns` stays bigint because `process.hrtime.bigint()` can exceed it.
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
 * Capability token that lets `SessionService.append` seed rows. It only ever comes from
 * `forTestsOnly()`, so configuration or deserialized data cannot switch the append on.
 *
 * - Compile time: the `#brand` private field makes the type nominal, and the private constructor
 *   leaves `forTestsOnly()` as the only way to get one.
 * - Runtime: the guard compares against the module-private singleton by identity, so a forged
 *   object cast to the type still fails.
 * - Package boundary: the token is not exported from the `session` barrel or the package root,
 *   and the package `exports` map only exposes `"."`, so code outside the package cannot import
 *   it.
 *
 * In-package code can still call `forTestsOnly()` behind an environment check. An ESLint rule
 * in `eslint.config.mjs` denies `forTestsOnly` access in `packages/runtime-daemon/src` outside
 * `__tests__/`, so such a call site fails lint.
 */
export class TestSeedingAppendToken {
  static readonly #singleton: TestSeedingAppendToken = new TestSeedingAppendToken();

  // A private field is invisible to structural typing, so only instances of this class fit.
  readonly #brand = "test-seeding-append" as const;

  private constructor() {}

  /** The only way to get a token; tests only. */
  static forTestsOnly(): TestSeedingAppendToken {
    return TestSeedingAppendToken.#singleton;
  }

  /** Identity check against the module-private singleton (never structural). */
  static isGenuine(candidate: TestSeedingAppendToken | undefined): boolean {
    // Identity alone decides; the `#brand` read cannot change the result and only keeps the
    // brand field read somewhere.
    return (
      candidate !== undefined &&
      candidate === TestSeedingAppendToken.#singleton &&
      candidate.#brand === "test-seeding-append"
    );
  }
}

/** Construction options for `SessionService`. */
export interface SessionServiceOptions {
  /**
   * Permits `append`'s test-seeding writes; tests only. It takes the identity-checked token, not
   * a boolean, so no config value or env string can turn it on. A production composition root
   * passes no options and gets a read-only service.
   */
  readonly allowTestSeedingAppend?: TestSeedingAppendToken;
}

/** Reads a session's events and replays them to a snapshot; `append` is a guarded test seeder. */
export class SessionService {
  // Only the statements are kept: each one references its database, which keeps the connection
  // alive.
  readonly #insertStmt: Statement;
  readonly #replayStmt: Statement;
  readonly #allowTestSeedingAppend: boolean;

  constructor(db: Database, options?: SessionServiceOptions) {
    this.#allowTestSeedingAppend = TestSeedingAppendToken.isGenuine(
      options?.allowTestSeedingAppend,
    );
    this.#insertStmt = db.prepare(
      `INSERT INTO session_events (
         id, session_id, sequence, occurred_at, monotonic_ns,
         category, type, actor, payload,
         correlation_id, causation_id, version
       ) VALUES (
         @id, @session_id, @sequence, @occurred_at, @monotonic_ns,
         @category, @type, @actor, @payload,
         @correlation_id, @causation_id, @version
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
      // Returns integer columns as bigint so a `monotonic_ns` above 2^53 round-trips exactly.
      .safeIntegers(true);
  }

  /**
   * Inserts one event row. Throws unless the service was built with the genuine
   * `TestSeedingAppendToken`, and on a duplicate (session, sequence), which the caller must
   * avoid.
   */
  append(event: StoredEvent): undefined {
    if (!this.#allowTestSeedingAppend) {
      throw new Error(
        "SessionService.append is guarded: it writes a caller-sequenced row outside the " +
          "append lock, with no size ceiling. Durable production writes belong " +
          "to EventLogService.append. Tests seeding rows opt in explicitly with the " +
          "identity-checked capability token: new SessionService(db, " +
          "{ allowTestSeedingAppend: TestSeedingAppendToken.forTestsOnly() }).",
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
    });
    if (result.changes !== 1) {
      throw new Error(
        `SessionService.append: expected 1 row inserted, got ${String(result.changes)} for session=${event.sessionId} sequence=${String(event.sequence)}`,
      );
    }
  }

  /** Returns a session's events ordered by `sequence ASC`, or `[]` for an unknown session. */
  readEvents(sessionId: string): ReadonlyArray<StoredEvent> {
    const rows: ReadonlyArray<SessionEventRow> = this.#replayStmt.all(
      sessionId,
    ) as ReadonlyArray<SessionEventRow>;
    return rows.map((row) => hydrateRow(row));
  }

  /** Replays a session to its snapshot, or `null` when it has no events. */
  replay(sessionId: string): DaemonSessionSnapshot | null {
    return projectReplay(this.readEvents(sessionId));
  }
}

function hydrateRow(row: SessionEventRow): StoredEvent {
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

// The read-side trust boundary: a row written by anything other than `append` may hold JSON that
// is not an object. Failing here names the row, where the consumer would fail with a misleading
// error. It checks only that the payload is an object; the payload schema is not re-validated.
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
