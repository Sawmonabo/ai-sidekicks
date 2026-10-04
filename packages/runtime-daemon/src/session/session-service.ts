// Reads a session's events back in `sequence ASC` order and replays them to a record. Replay
// does not persist snapshots; it rebuilds state from the event log each time.

import type { Database, Statement } from "better-sqlite3";

import type { DaemonSessionRecord, StoredEvent } from "./types.js";
import { rebuildSession } from "./session-projector.js";

// A row as better-sqlite3 returns it from the events query. `safeIntegers` applies to every
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

/** Reads a session's events and rebuilds its record from them. */
export class SessionService {
  // Only the statements are kept: each one references its database, which keeps the connection
  // alive.
  readonly #readEventsStatement: Statement;

  constructor(db: Database) {
    this.#readEventsStatement = db
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

  /** Returns a session's events ordered by `sequence ASC`, or `[]` for an unknown session. */
  readEvents(sessionId: string): ReadonlyArray<StoredEvent> {
    const rows: ReadonlyArray<SessionEventRow> = this.#readEventsStatement.all(
      sessionId,
    ) as ReadonlyArray<SessionEventRow>;
    return rows.map((row) => hydrateRow(row));
  }

  /** Rebuilds a session's record from its events, or `null` when it has no events. */
  rebuildSession(sessionId: string): DaemonSessionRecord | null {
    return rebuildSession(this.readEvents(sessionId));
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

// The read-side trust boundary: a stored row may hold JSON that is not an object. Failing here
// names the row, where the consumer would fail with a misleading error. It checks only that the
// payload is an object; the payload schema is not re-validated.
function parsePayload(row: SessionEventRow): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload);
  } catch (err) {
    throw new Error(
      `SessionService.hydrateRow: payload is not valid JSON for event id=${row.id} sequence=` +
        `${String(row.sequence)} (${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `SessionService.hydrateRow: payload must be a JSON object for event id=${row.id} ` +
        `sequence=${String(row.sequence)} (got ` +
        `${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed})`,
    );
  }
  return parsed as Record<string, unknown>;
}
