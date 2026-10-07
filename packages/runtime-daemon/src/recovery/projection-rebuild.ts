// Rebuilds a session's projections from its event log. A projection is a set of rows each event
// writes in its own write; a rebuild deletes the session's rows, folds the log from its first
// event through each projection's own statements, and writes the result with the session's cursor
// in one write, so the rows are never seen half rebuilt and a second rebuild writes the same rows.
//
// An event type no projection reads is passed by unparsed, so a type this build does not know
// stays a stub in the log and is never converted. An event a projection reads is parsed as its
// registered variant, and one that fails to parse, or contradicts what the fold already applied,
// fails the session's rebuild as a projection failure.

import type { Database, Statement } from "better-sqlite3";

import { DAEMON_SCOPE_SENTINEL_SESSION_ID } from "@ai-sidekicks/contracts/event/envelope";
import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import { SessionEventSchema } from "@ai-sidekicks/contracts/event/session";
import type { SessionEvent } from "@ai-sidekicks/contracts/event/variant-types";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { DATABASE_NOW_SQL, type WriteStatement } from "../database/statement.js";
import { WriteRefusedError, type DatabaseWriter } from "../database/writer.js";
import { sessionAppendLock } from "../events/session/append-lock.js";
import type { SessionService } from "../session/service.js";
import { hasSqliteErrorCode } from "../session/sqlite-error-code.js";
import { mintUuidV7 } from "../uuid-v7.js";

/** One projection's fold over one session's events, applied in sequence order. */
export interface SessionProjectionFold {
  /**
   * The statements that apply `event` to the rows. Throws {@link ProjectionFailureError} when the
   * event contradicts what the fold already applied.
   */
  apply(event: SessionEvent): readonly WriteStatement[];
}

/** A set of rows derived from the session log, as a rebuild replaces them. */
export interface SessionProjection {
  /** The projection's name in a rebuild's result. */
  readonly name: string;
  /** The event types the fold reads; every other event passes it by. */
  readonly eventTypes: ReadonlySet<string>;
  /** The statements that delete the session's rows. */
  clearStatements(sessionId: SessionId): readonly WriteStatement[];
  /** A fresh fold for one rebuild of `sessionId`. */
  createFold(sessionId: SessionId): SessionProjectionFold;
}

/** A session's events could not be folded into rows the daemon can trust. */
export class ProjectionFailureError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectionFailureError";
  }
}

/** A rebuild of one session; `force` rebuilds it even when its projections are current. */
export interface ProjectionRebuildRequest {
  readonly sessionId: SessionId;
  readonly force?: boolean | undefined;
}

/** What a rebuild did: the projections it replaced and the last event they reflect. */
export interface ProjectionRebuildResponse {
  readonly sessionId: SessionId;
  /** Empty when the session's projections were already current. */
  readonly rebuiltProjections: string[];
  readonly asOfSequence: number;
  /** The events the rebuild read. */
  readonly eventsApplied: number;
}

/** What the rebuild reads and writes through. */
export interface ProjectionRebuildServiceDeps {
  readonly reader: Database;
  readonly writer: Pick<DatabaseWriter, "write" | "flush">;
  readonly sessionEvents: Pick<SessionService, "readEventsAfterSequence">;
  readonly projections: readonly SessionProjection[];
}

// The `afterSequence` that reads a session from its first event.
const BEFORE_FIRST_SEQUENCE = -1;

// Bounds each read of the log, not the rebuild: its statements still land in one write.
const REBUILD_PAGE_SIZE = 1_000;

// Walks the session index one session at a time, so listing the sessions reads one index entry
// per session rather than every event.
const SELECT_SESSIONS_TO_REBUILD_SQL = `WITH RECURSIVE logged(session_id) AS (
    SELECT MIN(session_id) FROM session_events
    UNION ALL
    SELECT (SELECT MIN(session_id) FROM session_events WHERE session_id > logged.session_id)
      FROM logged WHERE logged.session_id IS NOT NULL
  ),
  heads AS (
    SELECT session_id,
           (SELECT MAX(sequence) FROM session_events
             WHERE session_events.session_id = logged.session_id) AS head_sequence
      FROM logged
     WHERE session_id IS NOT NULL AND session_id <> @sentinel
  )
  SELECT heads.session_id FROM heads
    LEFT JOIN projection_cursors ON projection_cursors.session_id = heads.session_id
   WHERE projection_cursors.session_id IS NULL
      OR projection_cursors.state <> 'current'
      OR projection_cursors.last_sequence < heads.head_sequence`;

const SELECT_CURSOR_SQL = `SELECT projection_cursors.last_sequence, projection_cursors.state,
    (SELECT MAX(sequence) FROM session_events WHERE session_id = @session_id) AS head_sequence
  FROM projection_cursors WHERE projection_cursors.session_id = @session_id`;

// A session with no cursor yet reflects no event until its rebuild lands.
const MARK_REBUILDING_SQL = `INSERT INTO projection_cursors
    (id, session_id, last_sequence, state, updated_at)
  VALUES (@id, @session_id, ${String(BEFORE_FIRST_SEQUENCE)}, 'rebuilding', ${DATABASE_NOW_SQL})
  ON CONFLICT (session_id) DO UPDATE
    SET state = 'rebuilding', updated_at = excluded.updated_at`;

const MARK_CURRENT_SQL = `UPDATE projection_cursors
  SET state = 'current', last_sequence = @last_sequence, updated_at = ${DATABASE_NOW_SQL}
  WHERE session_id = @session_id`;

const MARK_STALE_SQL = `UPDATE projection_cursors
  SET state = 'stale', updated_at = ${DATABASE_NOW_SQL}
  WHERE session_id = ?`;

/**
 * Where a session's projection cursor stands: current at its last sequence, being rebuilt, or left
 * stale by a rebuild that failed.
 */
export type ProjectionCursorState = "current" | "rebuilding" | "stale";

interface CursorRow {
  readonly last_sequence: number;
  readonly state: ProjectionCursorState;
  readonly head_sequence: number | null;
}

/** Rebuilds sessions' projections from their logs, and lists the sessions that need it. */
export class ProjectionRebuildService {
  readonly #deps: ProjectionRebuildServiceDeps;
  readonly #selectSessionsToRebuild: Statement<
    [{ sentinel: SessionId }],
    { session_id: SessionId }
  >;
  readonly #selectCursor: Statement<[{ session_id: SessionId }], CursorRow>;

  constructor(deps: ProjectionRebuildServiceDeps) {
    this.#deps = deps;
    this.#selectSessionsToRebuild = deps.reader.prepare(SELECT_SESSIONS_TO_REBUILD_SQL);
    this.#selectCursor = deps.reader.prepare(SELECT_CURSOR_SQL);
  }

  /**
   * Every session but the service's own whose projections do not reflect its newest event: no
   * cursor, a cursor behind the log, or one left stale or mid-rebuild.
   */
  listSessionsToRebuild(): SessionId[] {
    return this.#selectSessionsToRebuild
      .all({ sentinel: DAEMON_SCOPE_SENTINEL_SESSION_ID })
      .map((row) => row.session_id);
  }

  /**
   * Rebuilds the session's projections unless they are current and `force` is not set. Holds the
   * session's append lock throughout, so no event lands between the read and the write. Throws
   * {@link ProjectionFailureError}, after marking the session's cursor stale, when the log cannot
   * be folded into rows; any other throw is the store's own failure.
   */
  async rebuild(request: ProjectionRebuildRequest): Promise<ProjectionRebuildResponse> {
    const { sessionId } = request;
    return sessionAppendLock.run(sessionId, async () => {
      // Appends queued before the hold commit first, so the read below sees them.
      await this.#deps.writer.flush();
      const cursor = this.#selectCursor.get({ session_id: sessionId });
      if (
        request.force !== true &&
        cursor !== undefined &&
        cursor.state === "current" &&
        cursor.last_sequence >= (cursor.head_sequence ?? BEFORE_FIRST_SEQUENCE)
      ) {
        return {
          sessionId,
          rebuiltProjections: [],
          asOfSequence: cursor.last_sequence,
          eventsApplied: 0,
        };
      }
      await this.#deps.writer.write([
        { sql: MARK_REBUILDING_SQL, bindings: { id: mintUuidV7(), session_id: sessionId } },
      ]);
      try {
        const folded = this.#fold(sessionId);
        await this.#deps.writer.write([
          ...folded.statements,
          {
            sql: MARK_CURRENT_SQL,
            bindings: { session_id: sessionId, last_sequence: folded.asOfSequence },
          },
        ]);
        return {
          sessionId,
          rebuiltProjections: this.#deps.projections.map((projection) => projection.name),
          asOfSequence: folded.asOfSequence,
          eventsApplied: folded.eventsRead,
        };
      } catch (error) {
        if (!isProjectionFailure(error)) {
          throw error;
        }
        await this.#deps.writer.write([{ sql: MARK_STALE_SQL, bindings: [sessionId] }]);
        throw error instanceof ProjectionFailureError
          ? error
          : new ProjectionFailureError(
              `The rebuilt rows of session ${sessionId} contradict its log`,
              { cause: error },
            );
      }
    });
  }

  // Reads the whole log a page at a time and returns the statements that replace every
  // projection's rows.
  #fold(sessionId: SessionId): {
    statements: WriteStatement[];
    asOfSequence: number;
    eventsRead: number;
  } {
    const { projections, sessionEvents } = this.#deps;
    const folds = projections.map((projection) => ({
      eventTypes: projection.eventTypes,
      fold: projection.createFold(sessionId),
    }));
    const statements = projections.flatMap((projection) => projection.clearStatements(sessionId));
    let afterSequence = BEFORE_FIRST_SEQUENCE;
    let eventsRead = 0;
    let hasMore = true;
    while (hasMore) {
      const page = sessionEvents.readEventsAfterSequence({
        sessionId,
        afterSequence,
        limit: REBUILD_PAGE_SIZE,
      });
      for (const envelope of page.events) {
        const readers = folds.filter((entry) => entry.eventTypes.has(envelope.type));
        if (readers.length > 0) {
          const event = parseRegisteredVariant(envelope);
          for (const { fold } of readers) {
            statements.push(...fold.apply(event));
          }
        }
      }
      eventsRead += page.events.length;
      afterSequence = page.nextSequence;
      hasMore = page.hasMore;
    }
    return { statements, asOfSequence: afterSequence, eventsRead };
  }
}

function parseRegisteredVariant(envelope: EventEnvelope): SessionEvent {
  const parsed = SessionEventSchema.safeParse(envelope);
  if (!parsed.success) {
    throw new ProjectionFailureError(
      `Event ${envelope.id} (${envelope.type}, version ${envelope.version}) at sequence ` +
        `${String(envelope.sequence)} does not parse as its registered variant`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

// A refused guard or a broken constraint in the fold's write is a log the live rules would never
// have written, not a failing store.
function isProjectionFailure(error: unknown): boolean {
  return (
    error instanceof ProjectionFailureError ||
    error instanceof WriteRefusedError ||
    hasSqliteErrorCode(error, "SQLITE_CONSTRAINT")
  );
}
