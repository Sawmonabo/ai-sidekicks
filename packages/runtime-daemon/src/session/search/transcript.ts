// `transcript.search`: one session's hits from the full-text index, over every row the session
// holds whether or not a screen has loaded it. Hits come newest first, one per row, and the match
// count covers every match in the session so a find box's count speaks for all of it.

import type { Database, Statement } from "better-sqlite3";

import { decodeEventCursor, encodeEventCursor } from "@ai-sidekicks/contracts/session/id";
import { countEntriesFittingOneFrame } from "@ai-sidekicks/contracts/jsonrpc/page";
import { TRANSCRIPT_READ_LIMIT_MAX } from "@ai-sidekicks/contracts/transcript/operations";
import {
  TRANSCRIPT_SEARCH_TEXT_MAX_LEN,
  type TranscriptSearchHit,
  type TranscriptSearchRequest,
  type TranscriptSearchResponse,
} from "@ai-sidekicks/contracts/transcript/search";

import { SessionNotFoundError } from "../../ipc/session-errors.js";
import { indexRowidSql, isEventRowSql, ownerKeySql, sourceRowidSql } from "./index/columns.js";
import { MATCH_CLOSE_MARK, MATCH_OPEN_MARK, cutMarkedLine, readMarks } from "./marked-line.js";
import { matchExpressionOf } from "./query.js";

// The match narrowed to the session's key in the index, so a read's cost follows the session's own
// rows; a title, group or tag is no row of the log.
const SESSION_LOG_MATCH_SQL = `
  session_search_index MATCH
    @expression || ' AND owner_key : "' || ${ownerKeySql("@sessionId")} || '"'
  AND ${isEventRowSql("session_search_index.rowid")}`;

// How many matches each matching log row of the session holds in its text, counted as
// `highlight()` marks them, overlapping matches as one; the connection has the match count loaded.
const SESSION_ROW_MATCH_COUNTS_SQL = `
  SELECT match_count(session_search_index, 0)
    FROM session_search_index
   WHERE ${SESSION_LOG_MATCH_SQL}`;

// One page of those rows, newest first, before the cursor's position. A session's rows are
// inserted at its next sequence, each above every rowid then held, so within a session the
// index's descending rowid order is the log's newest-first order, and the page reads its own rows
// alone rather than sorting every match.
const SESSION_ROW_HITS_SQL = `
  SELECT event.id AS row_id, session_search_index.sequence,
         highlight(session_search_index, 0, @open, @close) AS marked
    FROM session_search_index
    JOIN session_events AS event
      ON event.rowid = ${sourceRowidSql("session_search_index.rowid", "event")}
   WHERE ${SESSION_LOG_MATCH_SQL}
     AND session_search_index.rowid <= (
           SELECT ${indexRowidSql("max(earlier.rowid)", "event")}
             FROM session_events AS earlier
            WHERE earlier.session_id = @sessionId AND earlier.sequence < @beforeSequence)
   ORDER BY session_search_index.rowid DESC
   LIMIT @rowLimit`;

const SESSION_EXISTS_SQL = `SELECT 1 FROM sessions WHERE id = ?`;

// What every read of one session's rows binds: the words' match and the session.
interface SessionRowParameters {
  readonly expression: string;
  readonly sessionId: string;
}

interface SessionRowHit {
  readonly row_id: string;
  readonly sequence: number;
  readonly marked: string;
}

/**
 * Answers `transcript.search` from the full-text index on a read connection with the match count
 * loaded (`loadMatchCount`); constructing it on one without throws.
 */
export class TranscriptSearchService {
  readonly #reader: Database;
  readonly #rowMatchCounts: Statement<SessionRowParameters, number>;
  readonly #rowHits: Statement<
    SessionRowParameters & {
      open: string;
      close: string;
      beforeSequence: number;
      rowLimit: number;
    },
    SessionRowHit
  >;
  readonly #sessionExists: Statement<[string], unknown>;

  constructor(reader: Database) {
    this.#reader = reader;
    this.#rowMatchCounts = reader
      .prepare<SessionRowParameters, number>(SESSION_ROW_MATCH_COUNTS_SQL)
      .pluck();
    this.#rowHits = reader.prepare(SESSION_ROW_HITS_SQL);
    this.#sessionExists = reader.prepare(SESSION_EXISTS_SQL);
  }

  /**
   * One page of the session's hits, newest first, before `beforeCursor` when it is given. Throws
   * `SessionNotFoundError` for a session the daemon does not hold and
   * `EventCursorUnresolvableError` for a cursor that names no position.
   */
  search(request: TranscriptSearchRequest): TranscriptSearchResponse {
    return this.#reader.transaction(() => this.#answer(request))();
  }

  #answer(request: TranscriptSearchRequest): TranscriptSearchResponse {
    if (this.#sessionExists.get(request.sessionId) === undefined) {
      throw new SessionNotFoundError("The daemon holds no session with this id.", {
        sessionId: request.sessionId,
      });
    }
    const beforeSequence =
      request.beforeCursor === undefined
        ? Number.MAX_SAFE_INTEGER
        : decodeEventCursor(request.beforeCursor);
    const matchExpression = matchExpressionOf(request.query);
    if (matchExpression === undefined) {
      return { matchCount: 0, hits: [], hasMore: false };
    }
    const session = { expression: matchExpression, sessionId: request.sessionId };
    let matchCount = 0;
    for (const rowMatchCount of this.#rowMatchCounts.iterate(session)) {
      matchCount += rowMatchCount;
    }
    const limit = request.limit ?? TRANSCRIPT_READ_LIMIT_MAX;
    // One candidate past the limit shows whether more remain.
    const candidates = this.#rowHits
      .all({
        ...session,
        open: MATCH_OPEN_MARK,
        close: MATCH_CLOSE_MARK,
        beforeSequence,
        rowLimit: limit + 1,
      })
      .map((row): TranscriptSearchHit => {
        const markedLine = cutMarkedLine(readMarks(row.marked), TRANSCRIPT_SEARCH_TEXT_MAX_LEN);
        return {
          rowId: row.row_id,
          cursor: encodeEventCursor(row.sequence),
          snippet: markedLine.line,
          matchRanges: markedLine.matchRanges,
        };
      });
    const pageSize = countEntriesFittingOneFrame(candidates, limit);
    const hits = candidates.slice(0, pageSize);
    const lastHit = hits.at(-1);
    return candidates.length > pageSize && lastHit !== undefined
      ? { matchCount, hits, hasMore: true, nextCursor: lastHit.cursor }
      : { matchCount, hits, hasMore: false };
  }
}
