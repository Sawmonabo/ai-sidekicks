// The session service's reads: one session's record, transcript cursors, live runs and standing
// events as `session.read` answers them, from the `sessions` row its events keep in step, its tags,
// its run rows and its log; the session's whole log, or a page of it after a known sequence; and a
// rebuild of the record from that log through the projector, over the same envelope reads the event
// log serves, which skip a range the session skipped past as damaged and, while its history is
// damaged, stop at its last good point.

import type { Database, Statement } from "better-sqlite3";

import type { AgentId } from "@ai-sidekicks/contracts/agent/definition";
import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import { type SessionId } from "@ai-sidekicks/contracts/session/id";
import { RUN_LIFECYCLE_EVENT_TYPES } from "@ai-sidekicks/contracts/event/registry";
import {
  encodeEventCursor,
  START_OF_LOG_POSITION,
} from "@ai-sidekicks/contracts/session/event-cursor";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { RunState } from "@ai-sidekicks/contracts/run/state";
import type {
  SessionLiveRun,
  SessionReadRequest,
  SessionReadResponse,
  SessionRecord,
  SessionShape,
  SessionStandingEvent,
  SessionState,
} from "@ai-sidekicks/contracts/session/methods";

import {
  prepareSessionEventReads,
  type DamagedFromSequenceReader,
  type SessionEventReads,
} from "../events/session/read.js";
import { sessionNotFound } from "./not-found.js";
import { rebuildSession } from "./projector.js";
import type { DaemonSessionRecord } from "./records.js";
import { sqlListOf } from "../database/sql-list.js";
import { RUN_TERMINAL_STATES } from "./run/transitions.js";

/**
 * A session's read as its row, tags, runs and log answer it, standing events included: everything
 * but the held draft.
 */
export interface SessionLogRead {
  session: Omit<SessionRecord, "draft">;
  transcriptCursors: SessionReadResponse["transcriptCursors"];
  liveRuns: SessionReadResponse["liveRuns"];
  standingEvents: SessionReadResponse["standingEvents"];
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

// A negative limit reads every event.
const NO_LIMIT = -1;

// The `sessions` columns `session.read` answers from.
interface SessionReadRow {
  readonly state: SessionState;
  readonly shape: SessionShape;
  readonly name: string | null;
  readonly muted_at: string | null;
  readonly pending_working_folder: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

// The `runs` columns a live run is answered from, with its agent and newest touch from its events.
interface LiveRunRow {
  readonly run_id: RunId;
  readonly parent_run_id: RunId | null;
  readonly state: RunState;
  readonly run_version: number;
  readonly agent_id: AgentId | null;
  readonly touched_at: string;
}

const RUN_LIFECYCLE_TYPES_SQL = RUN_LIFECYCLE_EVENT_TYPES.map((type) => `'${type}'`).join(", ");

// A run's agent is on its `run.queued` row, by id or inside the agent it brought in. Its newest
// touch is its newest `run_lifecycle` event. Both read the run-and-type index on the event log;
// the unary `+` drops the run id column's affinity, which would keep the index from serving.
const SELECT_LIVE_RUNS_SQL = `SELECT run_id, parent_run_id, state, run_version,
    (SELECT COALESCE(json_extract(queued.payload, '$.agentId'),
                     json_extract(queued.payload, '$.resolvedAgent.agentId'))
       FROM session_events AS queued
      WHERE queued.session_id = runs.session_id
        AND queued.type = 'run.queued'
        AND queued.run_id = +runs.run_id) AS agent_id,
    (SELECT touched.occurred_at
       FROM session_events AS touched
      WHERE touched.session_id = runs.session_id
        AND touched.sequence = (
          SELECT MAX(lifecycle.sequence)
            FROM session_events AS lifecycle
           WHERE lifecycle.session_id = runs.session_id
             AND lifecycle.type IN (${RUN_LIFECYCLE_TYPES_SQL})
             AND lifecycle.run_id = +runs.run_id)) AS touched_at
  FROM runs
  WHERE session_id = ?
    AND state NOT IN (${sqlListOf(RUN_TERMINAL_STATES)})
  ORDER BY rowid`;

// The sequences of the session's standing events (`SessionReadResponse.standingEvents`). A live
// run's newest measured window and newest compaction read the run-and-type index; the shells'
// lease changes and the events that brought an agent in read the type index. `UNION ALL`, since
// the arms name different events and a sorting `UNION` would trade the type index for a walk of
// the whole log in sequence order; the envelope read orders them. A live run with no such row
// answers NULL, which the outer select drops.
const SELECT_STANDING_SEQUENCES_SQL = `SELECT sequence FROM (
    SELECT (SELECT MAX(measured.sequence)
              FROM session_events AS measured
             WHERE measured.session_id = runs.session_id
               AND measured.type = 'usage.context_window_update'
               AND measured.run_id = +runs.run_id
               AND json_type(measured.payload, '$.windowUsedTokens') = 'integer'
               AND json_extract(measured.payload, '$.windowUsedTokens') >= 0
               AND json_type(measured.payload, '$.windowMaxTokens') = 'integer'
               AND json_extract(measured.payload, '$.windowMaxTokens') > 0) AS sequence
      FROM runs
     WHERE runs.session_id = @sessionId AND runs.state NOT IN (${sqlListOf(RUN_TERMINAL_STATES)})
    UNION ALL
    SELECT (SELECT MAX(compacted.sequence)
              FROM session_events AS compacted
             WHERE compacted.session_id = runs.session_id
               AND compacted.type = 'usage.context_compacted'
               AND compacted.run_id = +runs.run_id)
      FROM runs
     WHERE runs.session_id = @sessionId AND runs.state NOT IN (${sqlListOf(RUN_TERMINAL_STATES)})
    UNION ALL
    SELECT MAX(sequence)
      FROM session_events
     WHERE session_id = @sessionId AND type = 'pty.control_changed'
     GROUP BY CASE json_type(payload, '$.terminalId')
                WHEN 'text' THEN json_extract(payload, '$.terminalId')
              END
    UNION ALL
    SELECT sequence
      FROM session_events
     WHERE session_id = @sessionId AND type = 'session.created'
    UNION ALL
    SELECT sequence
      FROM session_events
     WHERE session_id = @sessionId
       AND type = 'run.queued'
       AND json_type(payload, '$.resolvedAgent') = 'object')
  WHERE sequence IS NOT NULL`;

/**
 * Reads one session: its record and cursors from its row, its whole log, or its record rebuilt
 * from that log.
 */
export class SessionService {
  readonly #reader: Database;
  readonly #eventReads: SessionEventReads;
  readonly #selectRow: Statement<[string], SessionReadRow>;
  readonly #selectTags: Statement<[string], { readonly tag: string }>;
  readonly #selectLiveRuns: Statement<[string], LiveRunRow>;
  readonly #selectStandingSequences: Statement<
    [{ readonly sessionId: string }],
    { readonly sequence: number }
  >;

  /** `readDamagedFromSequence` says where a damaged session's reads stop; none stop when absent. */
  constructor(reader: Database, readDamagedFromSequence?: DamagedFromSequenceReader) {
    this.#reader = reader;
    this.#eventReads = prepareSessionEventReads(reader, readDamagedFromSequence);
    this.#selectRow = reader.prepare(
      `SELECT state, shape, name, muted_at, pending_working_folder,
              created_at, updated_at
         FROM sessions
        WHERE id = ?`,
    );
    this.#selectTags = reader.prepare(
      "SELECT tag FROM session_tags WHERE session_id = ? ORDER BY tag_folded",
    );
    this.#selectLiveRuns = reader.prepare(SELECT_LIVE_RUNS_SQL);
    this.#selectStandingSequences = reader.prepare(SELECT_STANDING_SEQUENCES_SQL);
  }

  /**
   * The session's record, without the held draft, its transcript cursors, its runs not yet ended
   * and its standing events: `earliest` is the start of the log, `latest` its newest readable event,
   * or the start of the log too when its history is damaged before any. Row, tags, runs, standing
   * events and head are read in one snapshot, so no event the row, a run or a standing event
   * reflects lies past `latest`. Throws `session.not_found` for a session this daemon holds no row
   * for, and `MalformedStoredEventError` for a standing event that is not a well-formed envelope.
   */
  readSession(request: SessionReadRequest): SessionLogRead {
    const { row, tags, liveRuns, standingEvents, head } = this.#reader.transaction(() => ({
      row: this.#selectRow.get(request.sessionId),
      tags: this.#selectTags.all(request.sessionId).map((tagRow) => tagRow.tag),
      liveRuns: this.#selectLiveRuns.all(request.sessionId).map(readLiveRun),
      standingEvents: this.#readStandingEvents(request.sessionId),
      head: this.#eventReads.readHead(request.sessionId),
    }))();
    if (row === undefined) {
      throw sessionNotFound(request.sessionId);
    }
    return {
      session: {
        id: request.sessionId,
        state: row.state,
        shape: row.shape,
        ...(row.name === null ? {} : { name: row.name }),
        muted: row.muted_at !== null,
        pendingWorkingFolder:
          row.pending_working_folder === null ? null : { path: row.pending_working_folder },
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        tags,
      },
      transcriptCursors: {
        earliest: encodeEventCursor(START_OF_LOG_POSITION),
        latest: encodeEventCursor(head ?? START_OF_LOG_POSITION),
      },
      liveRuns,
      standingEvents,
    };
  }

  /**
   * The session's events after `afterSequence`, at most `limit` of them, only of `eventTypes` and
   * only before `beforeSequence` when each is given. Throws `MalformedStoredEventError` when a
   * stored row is not a well-formed envelope.
   */
  readEventsAfterSequence(
    request: EventsReadAfterSequenceRequest,
  ): EventsReadAfterSequenceResponse {
    // One row past the page says whether another page follows.
    const rows = this.#eventReads.readAfter(
      request.sessionId,
      request.afterSequence,
      request.limit === undefined ? NO_LIMIT : request.limit + 1,
      { eventTypes: request.eventTypes, beforeSequence: request.beforeSequence },
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

  #readStandingEvents(sessionId: SessionId): SessionStandingEvent[] {
    const sequences = this.#selectStandingSequences
      .all({ sessionId })
      .map((sequenceRow) => sequenceRow.sequence);
    return this.#eventReads
      .readAtSequences(sessionId, sequences)
      .map((event) => ({ cursor: encodeEventCursor(event.sequence), event }));
  }
}

function readLiveRun(row: LiveRunRow): SessionLiveRun {
  return {
    runId: row.run_id,
    ...(row.parent_run_id === null ? {} : { parentRunId: row.parent_run_id }),
    state: row.state,
    runVersion: row.run_version,
    ...(row.agent_id === null ? {} : { agentId: row.agent_id }),
    touchedAt: row.touched_at,
  };
}
