// The `session_events` reads, run on the daemon's read-only connection: a session's head, the rows
// after a log position, of every type or of named types, the rows up to one, the rows of a
// sequence window and the rows at named sequences, each in sequence order, and the check of a
// cursor against the head. A row crosses in from the database file, so each one is checked against
// the envelope contract on the way out. A range the session skipped past as damaged is never read,
// and while its history is damaged no read goes past its last good point.

import type { Database } from "better-sqlite3";

import { EventEnvelopeSchema, type EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import {
  START_OF_LOG_POSITION,
  decodeEventCursor,
  EventCursorUnresolvableError,
  type EventCursor,
} from "@ai-sidekicks/contracts/session/event-cursor";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { outsideSkippedRangesSql } from "./skipped-ranges.js";

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

/** A stored event row that is not a well-formed event envelope; `sequence` is the row's. */
export class MalformedStoredEventError extends Error {
  readonly sequence: number;

  constructor(message: string, sequence: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "MalformedStoredEventError";
    this.sequence = sequence;
  }
}

/**
 * The sequence a session's reads stop before while its history is damaged, `undefined` while it
 * reads whole.
 */
export type DamagedFromSequenceReader = (sessionId: SessionId) => number | undefined;

/** Which of the events after a position a read takes; every one when a member is absent. */
interface SessionEventFilter {
  /** Only events of these types. */
  readonly eventTypes?: readonly string[] | undefined;
  /** Only events before this sequence. */
  readonly beforeSequence?: number | undefined;
}

/**
 * The synchronous reads of one session's log; every list is in ascending sequence order. Each read
 * throws {@link MalformedStoredEventError} when a row is not a valid event envelope, which only a
 * write outside the append path can leave.
 */
export interface SessionEventReads {
  /**
   * The session's highest sequence it reads to, below its last good point while its history is
   * damaged, or `undefined` when it has no such event.
   */
  readHead(sessionId: SessionId): number | undefined;
  /**
   * Up to `limit` events with a sequence greater than `afterPosition`, every one when `limit` is
   * negative, and only those `filter` takes.
   */
  readAfter(
    sessionId: SessionId,
    afterPosition: number,
    limit: number,
    filter?: SessionEventFilter,
  ): EventEnvelope[];
  /** The newest `limit` events with a sequence at or below `beforePosition`. */
  readBefore(sessionId: SessionId, beforePosition: number, limit: number): EventEnvelope[];
  /** The events with a sequence from `fromSequence` to `toSequence`, both included. */
  readWindow(sessionId: SessionId, fromSequence: number, toSequence: number): EventEnvelope[];
  /** The events at the given sequences; a sequence the session holds no event at reads none. */
  readAtSequences(sessionId: SessionId, sequences: readonly number[]): EventEnvelope[];
}

const SELECTED_COLUMNS = `id, session_id, sequence, occurred_at, category, type, actor, payload,
       correlation_id, causation_id, version`;

// The bound of a read that has none: no session's log reaches this sequence.
const NO_SEQUENCE_BOUND = Number.MAX_SAFE_INTEGER;

/**
 * Prepares the reads on `reader`; `readDamagedFromSequence` says where a damaged session's reads
 * stop, and every session reads whole when it is absent.
 */
export function prepareSessionEventReads(
  reader: Database,
  readDamagedFromSequence: DamagedFromSequenceReader = () => undefined,
): SessionEventReads {
  const headStatement = reader.prepare(
    "SELECT MAX(sequence) AS sequence FROM session_events WHERE session_id = ?",
  );
  const afterStatement = reader.prepare(
    `SELECT ${SELECTED_COLUMNS}
       FROM session_events AS event
      WHERE session_id = ? AND sequence > ? AND sequence < ?
        AND ${outsideSkippedRangesSql("event")}
      ORDER BY sequence ASC
      LIMIT ?`,
  );
  const afterOfTypesStatement = reader.prepare(
    `SELECT ${SELECTED_COLUMNS}
       FROM session_events AS event
      WHERE session_id = ? AND sequence > ? AND sequence < ?
        AND type IN (SELECT value FROM json_each(?))
        AND ${outsideSkippedRangesSql("event")}
      ORDER BY sequence ASC
      LIMIT ?`,
  );
  // Newest first so the limit keeps the rows nearest the position; the read reverses them.
  const beforeStatement = reader.prepare(
    `SELECT ${SELECTED_COLUMNS}
       FROM session_events AS event
      WHERE session_id = ? AND sequence <= ? AND sequence < ?
        AND ${outsideSkippedRangesSql("event")}
      ORDER BY sequence DESC
      LIMIT ?`,
  );
  const windowStatement = reader.prepare(
    `SELECT ${SELECTED_COLUMNS}
       FROM session_events AS event
      WHERE session_id = ? AND sequence BETWEEN ? AND ? AND sequence < ?
        AND ${outsideSkippedRangesSql("event")}
      ORDER BY sequence ASC`,
  );
  const atSequencesStatement = reader.prepare(
    `SELECT ${SELECTED_COLUMNS}
       FROM session_events AS event
      WHERE session_id = ? AND sequence IN (SELECT value FROM json_each(?)) AND sequence < ?
        AND ${outsideSkippedRangesSql("event")}
      ORDER BY sequence ASC`,
  );
  // The earlier of a read's own bound and the session's last good point.
  const readBound = (sessionId: SessionId, beforeSequence: number | undefined): number =>
    Math.min(
      beforeSequence ?? NO_SEQUENCE_BOUND,
      readDamagedFromSequence(sessionId) ?? NO_SEQUENCE_BOUND,
    );

  return {
    readHead: (sessionId) => {
      const head = (headStatement.get(sessionId) as HeadRow).sequence;
      if (head === null) {
        return undefined;
      }
      const readTo = Math.min(head, readBound(sessionId, undefined) - 1);
      return readTo < 0 ? undefined : readTo;
    },
    readAfter: (sessionId, afterPosition, limit, filter) => {
      const before = readBound(sessionId, filter?.beforeSequence);
      const rows =
        filter?.eventTypes === undefined
          ? afterStatement.all(sessionId, afterPosition, before, limit)
          : afterOfTypesStatement.all(
              sessionId,
              afterPosition,
              before,
              JSON.stringify(filter.eventTypes),
              limit,
            );
      return (rows as StoredEventRow[]).map(readEnvelope);
    },
    readBefore: (sessionId, beforePosition, limit) =>
      (
        beforeStatement.all(
          sessionId,
          beforePosition,
          readBound(sessionId, undefined),
          limit,
        ) as StoredEventRow[]
      )
        .reverse()
        .map(readEnvelope),
    readWindow: (sessionId, fromSequence, toSequence) =>
      (
        windowStatement.all(
          sessionId,
          fromSequence,
          toSequence,
          readBound(sessionId, undefined),
        ) as StoredEventRow[]
      ).map(readEnvelope),
    readAtSequences: (sessionId, sequences) =>
      (
        atSequencesStatement.all(
          sessionId,
          JSON.stringify(sequences),
          readBound(sessionId, undefined),
        ) as StoredEventRow[]
      ).map(readEnvelope),
  };
}

/**
 * The log position `cursor` names, the start of the log when it is absent, checked against the
 * session's `head`, which the caller reads before any page so a cursor past it cannot pass on a
 * later commit. Throws `EventCursorUnresolvableError` for a cursor that names no position or one
 * past the head.
 */
export function resolveEventCursor(
  cursor: EventCursor | undefined,
  head: number | undefined,
): number {
  if (cursor === undefined) {
    return START_OF_LOG_POSITION;
  }
  const position = decodeEventCursor(cursor);
  if (position > (head ?? START_OF_LOG_POSITION)) {
    throw new EventCursorUnresolvableError(cursor);
  }
  return position;
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
      Number(row.sequence),
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
      Number(row.sequence),
      { cause: parsed.error },
    );
  }
  return parsed.data;
}
