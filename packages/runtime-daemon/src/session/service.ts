// Reads a session's events back in `sequence ASC` order, whole or a page after a known sequence,
// and rebuilds its record from the stored events on every call; no snapshot is persisted. A range
// the session skipped past as damaged is never read.

import type { Database, Statement } from "better-sqlite3";

import { EventEnvelopeSchema, type EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { outsideSkippedRangesSql } from "../events/session/skipped-ranges.js";
import type { DaemonSessionRecord, StoredEvent } from "./records.js";
import { rebuildSession as rebuildSessionFromEvents } from "./projector.js";

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

/** A page of a session's events after a known sequence; with no `limit`, every later event. */
export interface EventsReadAfterSequenceRequest {
  readonly sessionId: SessionId;
  /** The last sequence already read, or `-1` to read from the session's first event. */
  readonly afterSequence: number;
  readonly limit?: number | undefined;
  /** Only events of these types; every type when absent. */
  readonly eventTypes?: readonly string[] | undefined;
  /** Only events before this sequence; every later event when absent. */
  readonly beforeSequence?: number | undefined;
}

/** The page: its events in sequence order, and where the next page starts. */
export interface EventsReadAfterSequenceResponse {
  readonly events: EventEnvelope[];
  /** The `afterSequence` that reads the next page: the page's last sequence, or the request's. */
  readonly nextSequence: number;
  readonly hasMore: boolean;
}

const EVENT_COLUMNS_SQL = `id, session_id, sequence, occurred_at, monotonic_ns,
                category, type, actor, payload,
                correlation_id, causation_id, version`;

// SQLite reads a negative limit as no limit.
const NO_LIMIT = -1;

/** A stored event row whose payload or envelope fails to parse; `sequence` is the row's. */
export class MalformedStoredEventError extends Error {
  readonly sequence: number;

  constructor(message: string, sequence: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "MalformedStoredEventError";
    this.sequence = sequence;
  }
}

/** Reads a session's events and rebuilds its record from them. */
export class SessionService {
  // Only the statements are kept: each one references its database, which keeps the connection
  // alive.
  readonly #readEventsStatement: Statement;
  readonly #readEventsAfterSequenceStatement: Statement;

  constructor(db: Database) {
    this.#readEventsStatement = db
      .prepare(
        `SELECT ${EVENT_COLUMNS_SQL}
         FROM session_events AS event
         WHERE session_id = ? AND ${outsideSkippedRangesSql("event")}
         ORDER BY sequence ASC`,
      )
      // Returns integer columns as bigint so a `monotonic_ns` above 2^53 round-trips exactly.
      .safeIntegers(true);
    this.#readEventsAfterSequenceStatement = db
      .prepare(
        `SELECT ${EVENT_COLUMNS_SQL}
         FROM session_events AS event
         WHERE session_id = @session_id AND sequence > @after_sequence
           AND (@before_sequence IS NULL OR sequence < @before_sequence)
           AND (@event_types IS NULL OR type IN (SELECT value FROM json_each(@event_types)))
           AND ${outsideSkippedRangesSql("event")}
         ORDER BY sequence ASC
         LIMIT @limit`,
      )
      .safeIntegers(true);
  }

  /**
   * Returns the session's events after `afterSequence` as envelopes, at most `limit` of them,
   * only of `eventTypes` and only before `beforeSequence` when each is given. Throws {@link MalformedStoredEventError} when a stored
   * row is not a well-formed envelope.
   */
  readEventsAfterSequence(
    request: EventsReadAfterSequenceRequest,
  ): EventsReadAfterSequenceResponse {
    // One row past the page says whether another page follows.
    const rows = this.#readEventsAfterSequenceStatement.all({
      session_id: request.sessionId,
      after_sequence: request.afterSequence,
      event_types: request.eventTypes === undefined ? null : JSON.stringify(request.eventTypes),
      before_sequence: request.beforeSequence ?? null,
      limit: request.limit === undefined ? NO_LIMIT : request.limit + 1,
    }) as ReadonlyArray<SessionEventRow>;
    const hasMore = request.limit !== undefined && rows.length > request.limit;
    const events = (hasMore ? rows.slice(0, request.limit) : rows).map((row) =>
      toEventEnvelope(hydrateRow(row)),
    );
    return {
      events,
      nextSequence: events.at(-1)?.sequence ?? request.afterSequence,
      hasMore,
    };
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
    return rebuildSessionFromEvents(this.readEvents(sessionId));
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

// The tolerant envelope parse keeps an event type this build does not know as a stub.
function toEventEnvelope(event: StoredEvent): EventEnvelope {
  const parsed = EventEnvelopeSchema.safeParse({
    id: event.id,
    sessionId: event.sessionId,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    category: event.category,
    type: event.type,
    actor: event.actor,
    payload: event.payload,
    ...(event.correlationId === null ? {} : { correlationId: event.correlationId }),
    ...(event.causationId === null ? {} : { causationId: event.causationId }),
    version: event.version,
  });
  if (!parsed.success) {
    throw new MalformedStoredEventError(
      `The stored event id=${event.id} sequence=${String(event.sequence)} is not a well-formed ` +
        "envelope",
      event.sequence,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

// The read-side trust boundary: a stored row may hold JSON that is not an object. Failing here
// names the row, where the consumer would fail with a misleading error. It checks only that the
// payload is an object; the payload schema is not re-validated.
function parsePayload(row: SessionEventRow): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload);
  } catch (err) {
    throw new MalformedStoredEventError(
      `SessionService.hydrateRow: payload is not valid JSON for event id=${row.id} sequence=` +
        `${String(row.sequence)} (${err instanceof Error ? err.message : String(err)})`,
      Number(row.sequence),
      { cause: err },
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MalformedStoredEventError(
      `SessionService.hydrateRow: payload must be a JSON object for event id=${row.id} ` +
        `sequence=${String(row.sequence)} (got ` +
        `${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed})`,
      Number(row.sequence),
    );
  }
  return parsed as Record<string, unknown>;
}
