// `transcript.search`: one session's hits from the search index, over every row the session holds
// whether or not a screen has loaded it. Hits come newest first, one per row, and the match count
// covers every match in the session, counted as the lines are marked, so a find box's count speaks
// for all of it. A hit's line is read from the database by its key and marked on its text there;
// a row gone since the index saw it is passed over.

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
import type { SearchIndex } from "@ai-sidekicks/search-index";

import { sessionNotFound } from "../not-found.js";
import { HitLineReader } from "./hits.js";
import { indexKeyOf } from "./index/columns.js";
import type { IndexRowReader } from "./index/rows.js";
import { parseFindQuery } from "./query.js";

const SESSION_KEY_SQL = "SELECT rowid FROM sessions WHERE id = ?";

// The session's newest log row before a position. A session's rows are appended at its next
// sequence, each above every rowid then held, so within a session rowid order is the log's order.
const LAST_ROWID_BEFORE_SQL = `
  SELECT max(rowid) FROM session_events WHERE session_id = ? AND sequence < ?`;

/** Answers `transcript.search` from the search index and the daemon's read connection. */
export class TranscriptSearchService {
  readonly #reader: Database;
  readonly #index: Pick<SearchIndex, "findInSession">;
  readonly #hitLines: HitLineReader;
  readonly #sessionKey: Statement<[string], number>;
  readonly #lastRowidBefore: Statement<[string, number], number | null>;

  constructor(
    reader: Database,
    index: Pick<SearchIndex, "findInSession" | "markMatches">,
    rows: IndexRowReader,
  ) {
    this.#reader = reader;
    this.#index = index;
    this.#hitLines = new HitLineReader(rows, index, TRANSCRIPT_SEARCH_TEXT_MAX_LEN);
    this.#sessionKey = reader.prepare<[string], number>(SESSION_KEY_SQL).pluck();
    this.#lastRowidBefore = reader
      .prepare<[string, number], number | null>(LAST_ROWID_BEFORE_SQL)
      .pluck();
  }

  /**
   * One page of the session's hits, newest first, before `beforeCursor` when it is given. A
   * session whose history is damaged from `damagedFromSequence` on is searched before that point
   * alone, its hits and its match count both, as its reads stop there. Throws
   * `session.not_found` for a session the daemon does not hold and
   * `EventCursorUnresolvableError` for a cursor that names no position.
   */
  search(request: TranscriptSearchRequest, damagedFromSequence?: number): TranscriptSearchResponse {
    return this.#reader.transaction(() => this.#answer(request, damagedFromSequence))();
  }

  #answer(
    request: TranscriptSearchRequest,
    damagedFromSequence: number | undefined,
  ): TranscriptSearchResponse {
    const sessionKey = this.#sessionKey.get(request.sessionId);
    if (sessionKey === undefined) {
      throw sessionNotFound(request.sessionId);
    }
    const beforeSequence =
      request.beforeCursor === undefined ? undefined : decodeEventCursor(request.beforeCursor);
    const searchQuery = parseFindQuery(request.query);
    if (searchQuery === undefined) {
      return { matchCount: 0, hits: [], hasMore: false };
    }
    const { rowKeys, matchCounts } = this.#index.findInSession(sessionKey, searchQuery);
    const placeBefore = (sequence: number | undefined): number =>
      sequence === undefined
        ? 0
        : firstPlaceAtOrBelow(rowKeys, this.#highestKeyBefore(request.sessionId, sequence));
    // The rows a damaged session's reads still reach, which the count covers whole.
    const firstReadablePlace = placeBefore(damagedFromSequence);
    const firstPlace = Math.max(firstReadablePlace, placeBefore(beforeSequence));
    const matchCount = matchCounts
      .slice(firstReadablePlace)
      .reduce((total, rowMatchCount) => total + rowMatchCount, 0);
    const limit = request.limit ?? TRANSCRIPT_READ_LIMIT_MAX;
    // One candidate past the limit shows whether more remain.
    const candidates = this.#hitLines
      .readLines(rowKeys.slice(firstPlace), searchQuery, limit + 1)
      .flatMap(({ row, marked }): TranscriptSearchHit[] =>
        row.logRow === undefined
          ? []
          : [
              {
                rowId: row.logRow.eventId,
                cursor: encodeEventCursor(row.logRow.sequence),
                snippet: marked.line,
                matchRanges: marked.matchRanges,
              },
            ],
      );
    const pageSize = countEntriesFittingOneFrame(candidates, limit);
    const hits = candidates.slice(0, pageSize);
    const lastHit = hits.at(-1);
    return candidates.length > pageSize && lastHit !== undefined
      ? { matchCount, hits, hasMore: true, nextCursor: lastHit.cursor }
      : { matchCount, hits, hasMore: false };
  }

  // The highest key a row of the session before `beforeSequence` can have; -1 when it has none.
  #highestKeyBefore(sessionId: string, beforeSequence: number): number {
    const rowid = this.#lastRowidBefore.get(sessionId, beforeSequence) ?? null;
    return rowid === null ? -1 : indexKeyOf(rowid, "event");
  }
}

// The first place in `rowKeys`, highest first, whose key is at most `highestKey`.
function firstPlaceAtOrBelow(rowKeys: readonly number[], highestKey: number): number {
  let low = 0;
  let high = rowKeys.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((rowKeys[middle] ?? 0) > highestKey) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}
