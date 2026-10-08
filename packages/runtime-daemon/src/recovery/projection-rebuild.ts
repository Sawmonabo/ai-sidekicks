// Rebuilds a session's projections from its event log. A projection is a set of rows each event
// writes in its own write; a rebuild deletes the session's rows and marks its cursor `rebuilding`
// in one write, folds the log from its first event through each projection's own statements a
// page at a time, each page in its own write, and marks the cursor `current` at the session's head
// in the last page's write. Rows seen while the cursor is not `current` are not trusted, and a
// second rebuild writes the same rows.
//
// Only the event types a projection reads are read, so a type this build does not know stays a
// stub in the log and is never converted. An event that fails to parse as its envelope or its
// registered variant, or contradicts what the fold already applied, fails the session's rebuild as
// a projection failure naming that event. A rebuild can stop before a given event, so a session
// whose history is damaged folds every event before its first damaged one.

import type { Database, Statement } from "better-sqlite3";

import { DAEMON_SCOPE_SENTINEL_SESSION_ID } from "@ai-sidekicks/contracts/event/envelope";
import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import { SessionEventSchema } from "@ai-sidekicks/contracts/event/session";
import type { SessionEvent } from "@ai-sidekicks/contracts/event/variant-types";
import { START_OF_LOG_POSITION, type SessionId } from "@ai-sidekicks/contracts/session/id";

import { DATABASE_NOW_SQL, type WriteStatement } from "../database/statement.js";
import { WriteRefusedError, type DatabaseWriter } from "../database/writer.js";
import { sessionAppendLock } from "../events/session/append-lock.js";
import {
  MalformedStoredEventError,
  type EventsReadAfterSequenceRequest,
  type EventsReadAfterSequenceResponse,
  type SessionService,
} from "../session/service.js";
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
  /** The event types the fold reads; a rebuild reads only types some projection names. */
  readonly eventTypes: ReadonlySet<string>;
  /** The statements that delete the session's rows. */
  clearStatements(sessionId: SessionId): readonly WriteStatement[];
  /** A fresh fold for one rebuild of `sessionId`. */
  createFold(sessionId: SessionId): SessionProjectionFold;
}

/**
 * A session's events could not be folded into rows the daemon can trust. A failed rebuild names
 * the first event the fold could not take as `sequence`; a fold's own throw leaves it unset.
 */
export class ProjectionFailureError extends Error {
  readonly sequence: number | undefined;

  constructor(message: string, options?: ErrorOptions & { sequence?: number | undefined }) {
    super(message, options);
    this.name = "ProjectionFailureError";
    this.sequence = options?.sequence;
  }
}

/**
 * A rebuild of one session; `force` rebuilds it even when its projections are current, and
 * `beforeSequence` folds only the events before that one.
 */
export interface ProjectionRebuildRequest {
  readonly sessionId: SessionId;
  readonly force?: boolean | undefined;
  readonly beforeSequence?: number | undefined;
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

/** The most events one page of a rebuild reads and writes. */
export const REBUILD_PAGE_SIZE = 1_000;

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

const SELECT_CURSOR_SQL = `SELECT last_sequence, state FROM projection_cursors
  WHERE session_id = ?`;

// The head below `before_sequence`, every event when it is NULL.
const SELECT_HEAD_SEQUENCE_SQL = `SELECT MAX(sequence) AS head_sequence FROM session_events
  WHERE session_id = @session_id AND (@before_sequence IS NULL OR sequence < @before_sequence)`;

// Goes with the clear, so the cursor reflects no event until a page lands.
const MARK_REBUILDING_SQL = `INSERT INTO projection_cursors
    (id, session_id, last_sequence, state, updated_at)
  VALUES (@id, @session_id, ${String(START_OF_LOG_POSITION)}, 'rebuilding', ${DATABASE_NOW_SQL})
  ON CONFLICT (session_id) DO UPDATE
    SET last_sequence = excluded.last_sequence, state = 'rebuilding',
        updated_at = excluded.updated_at`;

// Goes with each page but the last, so a rebuild that fails later says how far its rows reached.
const ADVANCE_REBUILDING_SQL = `UPDATE projection_cursors
  SET last_sequence = @last_sequence, updated_at = ${DATABASE_NOW_SQL}
  WHERE session_id = @session_id`;

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

// The events one rebuild folds: the session's, up to `headSequence`, before `beforeSequence`.
interface FoldRange {
  readonly sessionId: SessionId;
  readonly headSequence: number;
  readonly beforeSequence: number | undefined;
}

interface CursorRow {
  readonly last_sequence: number;
  readonly state: ProjectionCursorState;
}

/** Rebuilds sessions' projections from their logs, and lists the sessions that need it. */
export class ProjectionRebuildService {
  readonly #deps: ProjectionRebuildServiceDeps;
  readonly #selectSessionsToRebuild: Statement<
    [{ sentinel: SessionId }],
    { session_id: SessionId }
  >;
  readonly #selectCursor: Statement<[SessionId], CursorRow>;
  readonly #selectHeadSequence: Statement<
    [{ session_id: SessionId; before_sequence: number | null }],
    { head_sequence: number | null }
  >;
  readonly #eventTypes: readonly string[];

  constructor(deps: ProjectionRebuildServiceDeps) {
    this.#deps = deps;
    this.#selectSessionsToRebuild = deps.reader.prepare(SELECT_SESSIONS_TO_REBUILD_SQL);
    this.#selectCursor = deps.reader.prepare(SELECT_CURSOR_SQL);
    this.#selectHeadSequence = deps.reader.prepare(SELECT_HEAD_SEQUENCE_SQL);
    this.#eventTypes = [
      ...new Set(deps.projections.flatMap((projection) => [...projection.eventTypes])),
    ];
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
   * The last event sequence the session's projection rows reflect, by its cursor; `undefined`
   * when the session has no cursor or its rows reflect no event.
   */
  readLastAppliedSequence(sessionId: SessionId): number | undefined {
    const lastSequence = this.#selectCursor.get(sessionId)?.last_sequence;
    return lastSequence === undefined || lastSequence < 0 ? undefined : lastSequence;
  }

  /**
   * Rebuilds the session's projections unless they are current and `force` is not set. Holds the
   * session's append lock throughout, so no event lands while it reads and writes. Throws
   * {@link ProjectionFailureError} naming the first event it could not fold, after marking the
   * session's cursor stale, when the log cannot be folded into rows; any other throw is the
   * store's own failure.
   */
  async rebuild(request: ProjectionRebuildRequest): Promise<ProjectionRebuildResponse> {
    const { sessionId } = request;
    return sessionAppendLock.run(sessionId, async () => {
      // Appends queued before the hold commit first, so the reads below see them.
      await this.#deps.writer.flush();
      const headSequence =
        this.#selectHeadSequence.get({
          session_id: sessionId,
          before_sequence: request.beforeSequence ?? null,
        })?.head_sequence ?? START_OF_LOG_POSITION;
      const cursor = this.#selectCursor.get(sessionId);
      if (
        request.force !== true &&
        cursor !== undefined &&
        cursor.state === "current" &&
        cursor.last_sequence >= headSequence
      ) {
        return {
          sessionId,
          rebuiltProjections: [],
          asOfSequence: cursor.last_sequence,
          eventsApplied: 0,
        };
      }
      const fold = { sessionId, headSequence, beforeSequence: request.beforeSequence };
      try {
        return await this.#rebuildFromFirstEvent(fold, REBUILD_PAGE_SIZE);
      } catch (error) {
        if (!isProjectionFailure(error)) {
          throw error;
        }
        let failure: unknown = error;
        // A refused page write names no event, so the fold runs again an event per page, where
        // the refused write is that one event's.
        if (!(error instanceof ProjectionFailureError && error.sequence !== undefined)) {
          try {
            return await this.#rebuildFromFirstEvent(fold, 1);
          } catch (relocatedError) {
            if (!isProjectionFailure(relocatedError)) {
              throw relocatedError;
            }
            failure = relocatedError;
          }
        }
        await this.#deps.writer.write([{ sql: MARK_STALE_SQL, bindings: [sessionId] }]);
        throw failure instanceof ProjectionFailureError
          ? failure
          : new ProjectionFailureError(
              `The rebuilt rows of session ${sessionId} contradict its log`,
              { cause: failure },
            );
      }
    });
  }

  // Clears the session's rows, marks its cursor rebuilding, then folds its log.
  async #rebuildFromFirstEvent(
    fold: FoldRange,
    pageSize: number,
  ): Promise<ProjectionRebuildResponse> {
    const { sessionId } = fold;
    await this.#deps.writer.write([
      ...this.#deps.projections.flatMap((projection) => projection.clearStatements(sessionId)),
      { sql: MARK_REBUILDING_SQL, bindings: { id: mintUuidV7(), session_id: sessionId } },
    ]);
    const eventsApplied = await this.#foldPages(fold, pageSize);
    return {
      sessionId,
      rebuiltProjections: this.#deps.projections.map((projection) => projection.name),
      asOfSequence: fold.headSequence,
      eventsApplied,
    };
  }

  // Folds the log a page at a time, writing each page's statements in its own write; the last
  // page's write marks the cursor current at `headSequence`. Returns the events read. A failure
  // names the event it came from; a refused write names its page's event only when the page
  // holds one.
  async #foldPages(fold: FoldRange, pageSize: number): Promise<number> {
    const { sessionId, headSequence } = fold;
    const folds = this.#deps.projections.map((projection) => ({
      eventTypes: projection.eventTypes,
      fold: projection.createFold(sessionId),
    }));
    let afterSequence = START_OF_LOG_POSITION;
    let eventsRead = 0;
    let hasMore = true;
    while (hasMore) {
      const page = this.#readPage({
        sessionId,
        afterSequence,
        limit: pageSize,
        eventTypes: this.#eventTypes,
        beforeSequence: fold.beforeSequence,
      });
      const statements: WriteStatement[] = [];
      for (const envelope of page.events) {
        const event = parseRegisteredVariant(envelope);
        for (const { eventTypes, fold: projectionFold } of folds) {
          if (eventTypes.has(event.type)) {
            statements.push(...applyNamingEvent(projectionFold, event));
          }
        }
      }
      statements.push(
        page.hasMore
          ? {
              sql: ADVANCE_REBUILDING_SQL,
              bindings: { session_id: sessionId, last_sequence: page.nextSequence },
            }
          : {
              sql: MARK_CURRENT_SQL,
              bindings: { session_id: sessionId, last_sequence: headSequence },
            },
      );
      const onlyEvent = page.events.length === 1 ? page.events[0] : undefined;
      await this.#deps.writer.write(statements).catch((error: unknown) => {
        throw onlyEvent !== undefined && isProjectionFailure(error)
          ? new ProjectionFailureError(
              `Event ${onlyEvent.id} at sequence ${String(onlyEvent.sequence)} of session ` +
                `${sessionId} contradicts the rows its log built before it`,
              { cause: error, sequence: onlyEvent.sequence },
            )
          : error;
      });
      eventsRead += page.events.length;
      afterSequence = page.nextSequence;
      hasMore = page.hasMore;
    }
    return eventsRead;
  }

  // A stored row that does not parse is a log the rows cannot be built from, not a failing store.
  #readPage(request: EventsReadAfterSequenceRequest): EventsReadAfterSequenceResponse {
    try {
      return this.#deps.sessionEvents.readEventsAfterSequence(request);
    } catch (error) {
      if (error instanceof MalformedStoredEventError) {
        throw new ProjectionFailureError(
          `A stored event of session ${request.sessionId} after sequence ` +
            `${String(request.afterSequence)} does not parse: ${error.message}`,
          { cause: error, sequence: error.sequence },
        );
      }
      throw error;
    }
  }
}

function parseRegisteredVariant(envelope: EventEnvelope): SessionEvent {
  const parsed = SessionEventSchema.safeParse(envelope);
  if (!parsed.success) {
    throw new ProjectionFailureError(
      `Event ${envelope.id} (${envelope.type}, version ${envelope.version}) at sequence ` +
        `${String(envelope.sequence)} does not parse as its registered variant`,
      { cause: parsed.error, sequence: envelope.sequence },
    );
  }
  return parsed.data;
}

// A fold's own contradiction names the event it came from.
function applyNamingEvent(
  fold: SessionProjectionFold,
  event: SessionEvent,
): readonly WriteStatement[] {
  try {
    return fold.apply(event);
  } catch (error) {
    if (error instanceof ProjectionFailureError && error.sequence === undefined) {
      throw new ProjectionFailureError(error.message, {
        cause: error,
        sequence: event.sequence,
      });
    }
    throw error;
  }
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
