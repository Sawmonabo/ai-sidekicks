// The session service's reads: one session's record and transcript cursors as `session.read`
// answers them, from the `sessions` row its events keep in step and its tags; the session's whole
// log, or a page of it after a known sequence; and a rebuild of the record from that log through
// the projector, over the same envelope reads the event log serves.

import type { Database, Statement } from "better-sqlite3";

import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import {
  encodeEventCursor,
  START_OF_LOG_POSITION,
  type SessionId,
} from "@ai-sidekicks/contracts/session/id";
import type {
  SessionReadRequest,
  SessionShape,
  SessionState,
} from "@ai-sidekicks/contracts/session/methods";
import type { WorktreeId } from "@ai-sidekicks/contracts/worktree/lifecycle";

import { prepareSessionEventReads, type SessionEventReads } from "../events/session/read.js";
import type { SessionLogRead } from "../ipc/handlers/session/read.js";
import { SessionNotFoundError } from "../ipc/session-errors.js";
import { rebuildSession } from "./projector.js";
import type { DaemonSessionRecord } from "./records.js";

/** A page of a session's events after a known sequence; with no `limit`, every later event. */
export interface EventsReadAfterSequenceRequest {
  readonly sessionId: SessionId;
  /** The last sequence already read, or `-1` to read from the session's first event. */
  readonly afterSequence: number;
  readonly limit?: number | undefined;
  /** Only events of these types; every type when absent. */
  readonly eventTypes?: readonly string[] | undefined;
}

/** The page: its events in sequence order, and where the next page starts. */
export interface EventsReadAfterSequenceResponse {
  readonly events: EventEnvelope[];
  /** The `afterSequence` that reads the next page: the page's last sequence, or the request's. */
  readonly nextSequence: number;
  readonly hasMore: boolean;
}

// A negative limit reads every event.
const NO_LIMIT = -1;

// The `sessions` columns `session.read` answers from.
interface SessionReadRow {
  readonly state: SessionState;
  readonly shape: SessionShape;
  readonly name: string | null;
  readonly muted_at: string | null;
  readonly pending_move: 0 | 1;
  readonly pending_worktree_id: WorktreeId | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * Reads one session: its record and cursors from its row, its whole log, or its record rebuilt
 * from that log.
 */
export class SessionService {
  readonly #reader: Database;
  readonly #eventReads: SessionEventReads;
  readonly #selectRow: Statement<[string], SessionReadRow>;
  readonly #selectTags: Statement<[string], { readonly tag: string }>;

  constructor(reader: Database) {
    this.#reader = reader;
    this.#eventReads = prepareSessionEventReads(reader);
    this.#selectRow = reader.prepare(
      `SELECT state, shape, name, muted_at, pending_move, pending_worktree_id,
              created_at, updated_at
         FROM sessions
        WHERE id = ?`,
    );
    this.#selectTags = reader.prepare(
      "SELECT tag FROM session_tags WHERE session_id = ? ORDER BY tag_folded",
    );
  }

  /**
   * The session's record, without the held draft, and its transcript cursors: `earliest` is the
   * start of the log, `latest` its newest event. Row, tags and head are read in one snapshot, so
   * no event the row reflects lies past `latest`. Throws {@link SessionNotFoundError} for a
   * session this daemon holds no row for.
   */
  readSession(request: SessionReadRequest): SessionLogRead {
    const { row, tags, head } = this.#reader.transaction(() => ({
      row: this.#selectRow.get(request.sessionId),
      tags: this.#selectTags.all(request.sessionId).map((tagRow) => tagRow.tag),
      head: this.#eventReads.readHead(request.sessionId),
    }))();
    if (row === undefined) {
      throw new SessionNotFoundError("This daemon holds no such session.", {
        sessionId: request.sessionId,
      });
    }
    if (head === undefined) {
      throw new Error(`Session ${request.sessionId} has a directory row but no events`);
    }
    return {
      session: {
        id: request.sessionId,
        state: row.state,
        shape: row.shape,
        ...(row.name === null ? {} : { name: row.name }),
        muted: row.muted_at !== null,
        pendingWorkingFolder:
          row.pending_move === 1 ? { worktreeId: row.pending_worktree_id } : null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        tags,
      },
      transcriptCursors: {
        earliest: encodeEventCursor(START_OF_LOG_POSITION),
        latest: encodeEventCursor(head),
      },
    };
  }

  /**
   * The session's events after `afterSequence`, at most `limit` of them and only of `eventTypes`
   * when it is given. Throws `MalformedStoredEventError` when a stored row is not a well-formed
   * envelope.
   */
  readEventsAfterSequence(
    request: EventsReadAfterSequenceRequest,
  ): EventsReadAfterSequenceResponse {
    // One row past the page says whether another page follows.
    const rows = this.#eventReads.readAfter(
      request.sessionId,
      request.afterSequence,
      request.limit === undefined ? NO_LIMIT : request.limit + 1,
      request.eventTypes,
    );
    const hasMore = request.limit !== undefined && rows.length > request.limit;
    const events = hasMore ? rows.slice(0, request.limit) : rows;
    return {
      events,
      nextSequence: events.at(-1)?.sequence ?? request.afterSequence,
      hasMore,
    };
  }

  /** Every event of the session's log in sequence order; none for a session with no events. */
  readEvents(sessionId: SessionId): EventEnvelope[] {
    const head = this.#eventReads.readHead(sessionId);
    return head === undefined ? [] : this.#eventReads.readWindow(sessionId, 0, head);
  }

  /**
   * Rebuilds the session's record from its whole log, or `null` when it has no events. Throws
   * what the projector throws for a log that does not open at `session.created`.
   */
  rebuildSession(sessionId: SessionId): DaemonSessionRecord | null {
    return rebuildSession(this.readEvents(sessionId));
  }
}
