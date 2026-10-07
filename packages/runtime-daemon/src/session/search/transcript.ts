// `transcript.search`: one session's hits from the full-text index, over every row the session
// holds whether or not a screen has loaded it. Hits come newest first, one per row, and the match
// count covers every match in the session so a find box's count speaks for all of it.

import type { Database, Statement } from "better-sqlite3";

import { decodeEventCursor, encodeEventCursor } from "@ai-sidekicks/contracts/session/id";
import {
  TRANSCRIPT_READ_LIMIT_MAX,
  countEntriesFittingOneFrame,
} from "@ai-sidekicks/contracts/transcript/operations";
import {
  TRANSCRIPT_SEARCH_TEXT_MAX_LEN,
  type TranscriptSearchHit,
  type TranscriptSearchRequest,
  type TranscriptSearchResponse,
} from "@ai-sidekicks/contracts/transcript/search";

import { SessionNotFoundError } from "../../ipc/session-errors.js";
import {
  MATCH_CLOSE_MARK,
  MATCH_OPEN_MARK,
  countMarkedMatches,
  readMarkedLine,
} from "./marked-line.js";
import { sessionKeySql } from "./index-columns.js";
import { matchExpressionOf } from "./query.js";

// The session's matching log rows, newest first; a title, group or tag is no row of the log. The
// match is narrowed to the session's key in the index, so its cost follows the session's own rows.
const SESSION_ROW_HITS_SQL = `
  SELECT event.id AS row_id, index_row.sequence,
         highlight(session_search_index, 0, @open, @close) AS marked
    FROM session_search_index AS index_row
    JOIN session_events AS event ON event.rowid = index_row.rowid / 4
   WHERE session_search_index MATCH
           @expression || ' AND session_key : "' || ${sessionKeySql("@sessionId")} || '"'
   ORDER BY index_row.sequence DESC`;

const SESSION_EXISTS_SQL = `SELECT 1 FROM sessions WHERE id = ?`;

interface SessionRowHit {
  readonly row_id: string;
  readonly sequence: number;
  readonly marked: string;
}

/** Answers `transcript.search` from the full-text index on the daemon's read connection. */
export class TranscriptSearchService {
  readonly #rowHits: Statement<
    { expression: string; sessionId: string; open: string; close: string },
    SessionRowHit
  >;
  readonly #sessionExists: Statement<[string], unknown>;

  constructor(reader: Database) {
    this.#rowHits = reader.prepare(SESSION_ROW_HITS_SQL);
    this.#sessionExists = reader.prepare(SESSION_EXISTS_SQL);
  }

  /**
   * One page of the session's hits, newest first, before `beforeCursor` when it is given. Throws
   * `SessionNotFoundError` for a session the daemon does not hold and
   * `EventCursorUnresolvableError` for a cursor that names no position.
   */
  search(request: TranscriptSearchRequest): TranscriptSearchResponse {
    if (this.#sessionExists.get(request.sessionId) === undefined) {
      throw new SessionNotFoundError("The daemon holds no session with this id.", {
        sessionId: request.sessionId,
      });
    }
    const beforePosition =
      request.beforeCursor === undefined ? undefined : decodeEventCursor(request.beforeCursor);
    const matchExpression = matchExpressionOf(request.query);
    if (matchExpression === undefined) {
      return { matchCount: 0, hits: [], hasMore: false };
    }
    const limit = request.limit ?? TRANSCRIPT_READ_LIMIT_MAX;
    let matchCount = 0;
    // One candidate past the limit shows whether more remain.
    const candidates: TranscriptSearchHit[] = [];
    const rows = this.#rowHits.all({
      expression: matchExpression,
      sessionId: request.sessionId,
      open: MATCH_OPEN_MARK,
      close: MATCH_CLOSE_MARK,
    });
    for (const row of rows) {
      matchCount += countMarkedMatches(row.marked);
      if (
        candidates.length > limit ||
        (beforePosition !== undefined && row.sequence >= beforePosition)
      ) {
        continue;
      }
      const markedLine = readMarkedLine(row.marked, TRANSCRIPT_SEARCH_TEXT_MAX_LEN);
      if (markedLine !== undefined) {
        candidates.push({
          rowId: row.row_id,
          cursor: encodeEventCursor(row.sequence),
          snippet: markedLine.line,
          matchRanges: markedLine.matchRanges,
        });
      }
    }
    const pageSize = countEntriesFittingOneFrame(candidates, limit);
    const hits = candidates.slice(0, pageSize);
    const lastHit = hits.at(-1);
    return candidates.length > pageSize && lastHit !== undefined
      ? { matchCount, hits, hasMore: true, nextCursor: lastHit.cursor }
      : { matchCount, hits, hasMore: false };
  }
}
