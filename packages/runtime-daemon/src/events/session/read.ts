// The `session_events` reads, run on the daemon's read-only connection: a session's head, the rows
// after a log position, of every type or of named types, and the rows of a sequence window, each in
// sequence order. A row crosses in from the database file, so each one is checked against the
// envelope contract on the way out.

import type { Database } from "better-sqlite3";

import { EventEnvelopeSchema, type EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

/** A `session_events` row as the reads select it, before it is checked. */
interface StoredEventRow {
  readonly id: unknown;
  readonly session_id: unknown;
  readonly sequence: unknown;
  readonly occurred_at: unknown;
  readonly category: unknown;
  readonly type: unknown;
  readonly actor: unknown;
  readonly payload: string;
  readonly correlation_id: unknown;
  readonly causation_id: unknown;
  readonly version: unknown;
}

/** The head row; `sequence` is NULL when the session has no events. */
interface HeadRow {
  readonly sequence: number | null;
}

/** A stored event row that is not a well-formed event envelope. */
export class MalformedStoredEventError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MalformedStoredEventError";
  }
}

/**
 * The synchronous reads of one session's log; every list is in ascending sequence order. Each read
 * throws {@link MalformedStoredEventError} when a row is not a valid event envelope, which only a
 * write outside the append path can leave.
 */
export interface SessionEventReads {
  /** The session's highest sequence, or `undefined` when it has no events. */
  readHead(sessionId: SessionId): number | undefined;
  /**
   * Up to `limit` events with a sequence greater than `afterPosition`, every one when `limit` is
   * negative, and only those of `eventTypes` when it is given.
   */
  readAfter(
    sessionId: SessionId,
    afterPosition: number,
    limit: number,
    eventTypes?: readonly string[],
  ): EventEnvelope[];
  /** The events with a sequence from `fromSequence` to `toSequence`, both included. */
  readWindow(sessionId: SessionId, fromSequence: number, toSequence: number): EventEnvelope[];
}

const SELECTED_COLUMNS = `id, session_id, sequence, occurred_at, category, type, actor, payload,
       correlation_id, causation_id, version`;

/** Prepares the reads on `reader`. */
export function prepareSessionEventReads(reader: Database): SessionEventReads {
  const headStatement = reader.prepare(
    "SELECT MAX(sequence) AS sequence FROM session_events WHERE session_id = ?",
  );
  const afterStatement = reader.prepare(
    `SELECT ${SELECTED_COLUMNS}
       FROM session_events
      WHERE session_id = ? AND sequence > ?
      ORDER BY sequence ASC
      LIMIT ?`,
  );
  const afterOfTypesStatement = reader.prepare(
    `SELECT ${SELECTED_COLUMNS}
       FROM session_events
      WHERE session_id = ? AND sequence > ? AND type IN (SELECT value FROM json_each(?))
      ORDER BY sequence ASC
      LIMIT ?`,
  );
  const windowStatement = reader.prepare(
    `SELECT ${SELECTED_COLUMNS}
       FROM session_events
      WHERE session_id = ? AND sequence BETWEEN ? AND ?
      ORDER BY sequence ASC`,
  );

  return {
    readHead: (sessionId) => {
      const head = headStatement.get(sessionId) as HeadRow;
      return head.sequence ?? undefined;
    },
    readAfter: (sessionId, afterPosition, limit, eventTypes) =>
      (
        (eventTypes === undefined
          ? afterStatement.all(sessionId, afterPosition, limit)
          : afterOfTypesStatement.all(
              sessionId,
              afterPosition,
              JSON.stringify(eventTypes),
              limit,
            )) as StoredEventRow[]
      ).map(readEnvelope),
    readWindow: (sessionId, fromSequence, toSequence) =>
      (windowStatement.all(sessionId, fromSequence, toSequence) as StoredEventRow[]).map(
        readEnvelope,
      ),
  };
}

// Storage keeps an absent correlation or causation id as NULL, which the envelope omits.
function readEnvelope(row: StoredEventRow): EventEnvelope {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch (error) {
    throw new MalformedStoredEventError(
      `session_events.payload of event ${String(row.id)} at sequence ${String(row.sequence)} ` +
        "is not JSON, so the row was written outside the append path.",
      { cause: error },
    );
  }
  // The tolerant envelope parse keeps an event type this build does not know as a stub.
  const parsed = EventEnvelopeSchema.safeParse({
    id: row.id,
    sessionId: row.session_id,
    sequence: row.sequence,
    occurredAt: row.occurred_at,
    category: row.category,
    type: row.type,
    actor: row.actor,
    payload,
    ...(row.correlation_id === null ? {} : { correlationId: row.correlation_id }),
    ...(row.causation_id === null ? {} : { causationId: row.causation_id }),
    version: row.version,
  });
  if (!parsed.success) {
    throw new MalformedStoredEventError(
      `The stored event ${String(row.id)} at sequence ${String(row.sequence)} is not a ` +
        "well-formed envelope, so the row was written outside the append path.",
      { cause: parsed.error },
    );
  }
  return parsed.data;
}
