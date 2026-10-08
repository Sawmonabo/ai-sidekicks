// The `session_events` row write, run on the database writer's connection: it reads the session's
// head and inserts the row with the next sequence in one synchronous step, so two appends never
// derive one sequence. The same step advances the session's projection cursor, because every
// projection row an event moves is written in that event's own write.

import type { Database } from "better-sqlite3";

import { DATABASE_NOW_SQL } from "../../database/statement.js";
import { mintUuidV7 } from "../../uuid-v7.js";

/** A `session_events` row as bound, snake_case to match the columns, before its sequence exists. */
export interface SessionEventRow {
  readonly id: string;
  readonly session_id: string;
  readonly occurred_at: string;
  readonly monotonic_ns: bigint;
  readonly category: string;
  readonly type: string;
  readonly actor: string | null;
  readonly payload: string;
  readonly correlation_id: string | null;
  readonly causation_id: string | null;
  readonly version: string;
  readonly content_payload: string | null;
}

/** The head row; `sequence` is `unknown` because SQLite does not enforce column types. */
interface HeadRow {
  readonly sequence: unknown;
}

// A new session's cursor starts current; an existing one keeps its state, so a session marked
// for rebuilding stays marked until its rebuild lands.
const ADVANCE_PROJECTION_CURSOR_SQL = `INSERT INTO projection_cursors
    (id, session_id, last_sequence, state, updated_at)
  VALUES (@id, @session_id, @last_sequence, 'current', ${DATABASE_NOW_SQL})
  ON CONFLICT (session_id) DO UPDATE
    SET last_sequence = excluded.last_sequence,
        updated_at = excluded.updated_at`;

/**
 * Prepares the row write on `database` and returns it: each call inserts one row at the session's
 * next sequence, advances the session's projection cursor to it, and returns that sequence. Throws
 * when the stored head is not an integer, when the next sequence would pass the safe integers, or
 * when the insert does not land exactly one row.
 */
export function prepareSessionEventInsert(database: Database): (row: SessionEventRow) => number {
  const insertStatement = database.prepare(
    `INSERT INTO session_events (
       id, session_id, sequence, occurred_at, monotonic_ns,
       category, type, actor, payload,
       correlation_id, causation_id, version, content_payload
     ) VALUES (
       @id, @session_id, @sequence, @occurred_at, @monotonic_ns,
       @category, @type, @actor, @payload,
       @correlation_id, @causation_id, @version, @content_payload
     )`,
  );
  // `safeIntegers` reads the INTEGER as a bigint, lossless past 2^53.
  const headStatement = database
    .prepare(
      `SELECT sequence
         FROM session_events
        WHERE session_id = ?
        ORDER BY sequence DESC
        LIMIT 1`,
    )
    .safeIntegers(true);
  const advanceCursorStatement = database.prepare(ADVANCE_PROJECTION_CURSOR_SQL);

  return (row) => {
    const head = headStatement.get(row.session_id) as HeadRow | undefined;
    const sequence: number =
      head === undefined ? 0 : nextSafeSequence(narrowHeadSequence(head.sequence, row.session_id));
    const result = insertStatement.run({ ...row, sequence });
    if (result.changes !== 1) {
      // Unreachable through a plain INSERT, but a silent zero would report a sequence for a row
      // that is not durable.
      throw new Error(
        `The session_events insert changed ${String(result.changes)} rows, not 1, for ` +
          `session=${row.session_id} sequence=${String(sequence)}`,
      );
    }
    // Runs for the service's own sentinel session too, whose cursor is written and never read.
    advanceCursorStatement.run({
      id: mintUuidV7(),
      session_id: row.session_id,
      last_sequence: sequence,
    });
    return sequence;
  };
}

/**
 * The stored head `sequence`, checked rather than asserted: affinity leaves non-numeric TEXT and
 * REAL as they are, which would become `NaN` or a fractional sequence after `+ 1`.
 */
function narrowHeadSequence(value: unknown, sessionId: string): bigint {
  if (typeof value !== "bigint") {
    throw new Error(
      `session_events.sequence for session ${sessionId} is not an INTEGER: got a value of ` +
        `type ${typeof value}. The column is declared INTEGER NOT NULL and this statement ` +
        `reads it with safeIntegers, so a non-bigint value means the row was written or ` +
        `altered outside this module. Refusing here rather than allocating the next sequence ` +
        `from it.`,
    );
  }
  return value;
}

// Past 2^53 - 1 distinct sequences collapse onto one number when read back.
function nextSafeSequence(head: bigint): number {
  const next: bigint = head + 1n;
  if (next > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `The next session_events.sequence, ${String(next)}, is past the safe integers; refusing ` +
        `to store a sequence that would read back as another.`,
    );
  }
  return Number(next);
}
