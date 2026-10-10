// `session.search`: every session's hits from the search index, archived sessions included, one
// page at a time, so every hit is reachable while each answer stays inside its budget and one
// message. Hits are grouped by session, the sessions in the order of their best hit.
//
// Words rank by the index's BM25 order. The first page opens a view of the index and holds it, and
// every later page reads that view, so a write between pages neither repeats nor drops a hit the
// view held. A hit's line is read from the database by its key and marked on the row's text as it
// is now: a hit whose row is gone is passed over, and so is one whose rowid a later row has taken
// since the view, which the rowid floor log tells. A `tag:<tag>` term keeps the sessions that carry
// that tag or one nested under it, which the index finds without scoring: with words, the index
// ranks only those sessions' rows; with no word, the sessions come most recently active first and
// their hits are the tags that matched. Names, groups and lines are read only for a page's own
// sessions. The search box names no session, so no relation rank takes part.

import type { Database, Statement } from "better-sqlite3";

import { type SessionId } from "@ai-sidekicks/contracts/session/id";
import {
  START_OF_LOG_POSITION,
  encodeEventCursor,
} from "@ai-sidekicks/contracts/session/event-cursor";
import {
  type SessionSearchCursor,
  type SessionSearchHit,
  type SessionSearchRequest,
  type SessionSearchResponse,
} from "@ai-sidekicks/contracts/session/methods";
import {
  SESSION_SEARCH_HIT_LINE_MAX_LEN,
  SESSION_SEARCH_PAGE_LIMIT_MAX,
} from "@ai-sidekicks/contracts/session/search";
import type { SearchIndex } from "@ai-sidekicks/search-index";

import {
  decodeSearchCursor,
  encodeSearchCursor,
  searchCursorUnresolvable,
  type SearchPagePosition,
} from "./cursor.js";
import { HitLineReader, type HitLine } from "./hits.js";
import { indexKeyOf } from "./index/columns.js";
import type { IndexRowReader } from "./index/rows.js";
import { assembleSearchPage, type PageCandidate, type SearchPage } from "./page.js";
import { parseSessionSearchQuery, type ParsedSearchQuery } from "./query.js";
import type { HeldRowCheck, RowidFloorLog } from "./rowid-floors.js";
import {
  DEFAULT_SEARCH_SNAPSHOT_LIMITS,
  SearchSnapshots,
  type SearchSnapshot,
} from "./snapshots.js";

// The sessions the directory holds among these keys; a session since purged has no row.
const SESSIONS_BY_KEY_SQL = `
  SELECT rowid AS session_key, id AS session_id, name
    FROM sessions WHERE rowid IN (SELECT value FROM json_each(?))`;

interface SessionRow {
  readonly session_key: number;
  readonly session_id: SessionId;
  readonly name: string | null;
}

// A cursor read back, which a later page resumes from.
interface PageResume {
  readonly cursor: SessionSearchCursor;
  readonly position: SearchPagePosition;
}

// A hit a page may show, with the index key a cursor names it by.
interface ShownHit {
  readonly key: number;
  readonly hit: SessionSearchHit;
}

// Sessions are read a batch at a time while a page fills. A read costs what its sessions' hits
// cost, so the first batch is small and each later one holds the sessions the page's room takes at
// the last batch's hits per session, sessions further down holding fewer, and the one after them,
// which tells where the next page starts: at least the first batch's size and at most four times
// the last. A page of sessions that each hold many hits reads few sessions it never shows, and a
// page of sessions with one hit each still takes three reads.
const FIRST_READ_BATCH_SIZE = 16;
const READ_BATCH_GROWTH = 4;

// A title, group or tag hit names no row of the session's log, so it opens the session at its
// start.
const SESSION_START_CURSOR = encodeEventCursor(START_OF_LOG_POSITION);

/**
 * What `session.search` and `transcript.search` read: the daemon's read connection, the search
 * index, its rows in the database and the rowid floor log.
 */
export interface SearchServiceDeps {
  readonly reader: Database;
  readonly index: Pick<SearchIndex, "openSearch" | "findInSession" | "markMatches">;
  readonly rows: IndexRowReader;
  readonly floorLog: RowidFloorLog;
  /**
   * Where the rowid floor log stood when the index last matched the database; a search opened now
   * checks its rows from there.
   */
  readonly appliedFloorPosition: () => number;
}

/** Answers `session.search` from the search index and the daemon's read connection. */
export class SessionSearchService {
  readonly #reader: Database;
  readonly #index: Pick<SearchIndex, "openSearch" | "markMatches">;
  readonly #floorLog: RowidFloorLog;
  readonly #appliedFloorPosition: () => number;
  readonly #hitLines: HitLineReader;
  readonly #sessionsByKey: Statement<[string], SessionRow>;
  readonly #snapshots: SearchSnapshots;

  constructor(deps: SearchServiceDeps) {
    this.#reader = deps.reader;
    this.#index = deps.index;
    this.#floorLog = deps.floorLog;
    this.#appliedFloorPosition = deps.appliedFloorPosition;
    this.#hitLines = new HitLineReader(deps.rows, deps.index, SESSION_SEARCH_HIT_LINE_MAX_LEN);
    this.#sessionsByKey = deps.reader.prepare(SESSIONS_BY_KEY_SQL);
    this.#snapshots = new SearchSnapshots(DEFAULT_SEARCH_SNAPSHOT_LIMITS);
  }

  /**
   * One page of the query's hits, grouped by session, from `afterCursor` when it is given; a
   * query that names nothing answers an empty last page. A page reads the database in one read
   * transaction, and every page after the first reads the view the first one held. Throws
   * `session.search_cursor_unresolvable` for a cursor that continues no search held for this
   * query.
   */
  search(request: SessionSearchRequest): SessionSearchResponse {
    return this.#reader.transaction(() => this.#answer(request))();
  }

  /** The lowest place in the rowid floor log a held search still reads from, if any is held. */
  oldestHeldFloorPosition(): number | undefined {
    return this.#snapshots.oldestFloorPosition();
  }

  /** Lets go of every held search, as the index closes; their cursors are refused from then on. */
  letGoOfHeldSearches(): void {
    this.#snapshots.letGoOfAll();
  }

  #answer(request: SessionSearchRequest): SessionSearchResponse {
    const query = parseSessionSearchQuery(request.query);
    const queryKey = JSON.stringify(query);
    const limit = request.limit ?? SESSION_SEARCH_PAGE_LIMIT_MAX;
    const { afterCursor } = request;
    if (afterCursor !== undefined) {
      const { snapshotId, position } = decodeSearchCursor(afterCursor);
      const snapshot = this.#snapshots.find(snapshotId);
      if (snapshot?.queryKey !== queryKey) {
        throw searchCursorUnresolvable(afterCursor);
      }
      const page = this.#readHeldPage(snapshot, limit, { cursor: afterCursor, position });
      return toResponse(page, () => snapshotId);
    }
    const snapshot = this.#openSearch(query, queryKey);
    if (snapshot === undefined) {
      return { groups: [], hasMore: false };
    }
    let page: SearchPage;
    try {
      page = this.#readHeldPage(snapshot, limit, undefined);
    } catch (error) {
      // No cursor names a search whose first page failed, so nothing would let its view go.
      snapshot.view.release();
      throw error;
    }
    // A search answered whole on its first page has no later page to hold it for.
    if (page.next === undefined) {
      snapshot.view.release();
    }
    return toResponse(page, () => this.#snapshots.hold(snapshot));
  }

  // The search a first page opens, a view of the index with its order of sessions; `undefined`
  // when the query names neither a word nor a tag.
  #openSearch(query: ParsedSearchQuery, queryKey: string): SearchSnapshot | undefined {
    const { searchQuery, tagFolds } = query;
    if (searchQuery === undefined && tagFolds.length === 0) {
      return undefined;
    }
    // Read before the view opens, so it is never newer than the view.
    const floorPosition = this.#appliedFloorPosition();
    const view = this.#index.openSearch([...tagFolds], searchQuery);
    return { queryKey, query, view, floorPosition };
  }

  // A page of a held search, from where `resume` names when a cursor continues it.
  #readHeldPage(
    snapshot: SearchSnapshot,
    limit: number,
    resume: PageResume | undefined,
  ): SearchPage {
    const candidates = this.#candidates(
      snapshot,
      this.#floorLog.heldRowCheck(snapshot.floorPosition),
      resume,
      limit,
    );
    return assembleSearchPage(candidates, limit, (hits) => hits.map((shown) => shown.hit));
  }

  // The sessions of a held search's order from where `resume` names on, a batch at a time, each
  // with its hits that still hold a match, the lines of the sessions up to where the page may end
  // read together, each session's one past what a page holds so a session with more splits across
  // pages; the first with only those after the last hit an earlier page showed. A session since
  // purged, or one whose rowid a later session took, is passed over, and so is a hit whose row is
  // gone or was taken. Throws `session.search_cursor_unresolvable` when the cursor's hit is none of
  // its session's hits.
  *#candidates(
    snapshot: SearchSnapshot,
    isHeldRow: HeldRowCheck | undefined,
    resume: PageResume | undefined,
    limit: number,
  ): Generator<PageCandidate<ShownHit>> {
    const start = resume?.position;
    const firstIndex = start?.sessionIndex ?? 0;
    let batchStart = firstIndex;
    let batchSize = FIRST_READ_BATCH_SIZE;
    let hitsOffered = 0;
    for (;;) {
      const sessionKeys = snapshot.view.sessionsAt(batchStart, batchSize);
      if (sessionKeys.length === 0) {
        return;
      }
      const sessions = this.#readSessions(
        isHeldRow === undefined
          ? sessionKeys
          : sessionKeys.filter((sessionKey) => isHeldRow(indexKeyOf(sessionKey, "title"))),
      );
      const heldKeys = sessionKeys.filter((sessionKey) => sessions.has(sessionKey));
      const hitKeysOfHeld = heldKeys.length === 0 ? [] : snapshot.view.hitsOf(heldKeys);
      const hitKeysBySession = new Map(
        heldKeys.map((sessionKey, index) => [sessionKey, hitKeysOfHeld[index] ?? []]),
      );
      const { searchQuery, tagFolds } = snapshot.query;
      const shown = sessionKeys.flatMap((sessionKey, offset) => {
        const session = sessions.get(sessionKey);
        if (session === undefined) {
          return [];
        }
        const sessionIndex = batchStart + offset;
        let hitKeys = hitKeysBySession.get(sessionKey) ?? [];
        const resumeAfter = sessionIndex === firstIndex ? start?.afterHitKey : undefined;
        if (resume !== undefined && resumeAfter !== undefined) {
          const shownThrough = hitKeys.indexOf(resumeAfter);
          if (shownThrough === -1) {
            throw searchCursorUnresolvable(resume.cursor);
          }
          hitKeys = hitKeys.slice(shownThrough + 1);
        }
        const heldHitKeys = isHeldRow === undefined ? hitKeys : hitKeys.filter(isHeldRow);
        return [{ session, sessionIndex, resumeAfter, heldHitKeys }];
      });
      let batchHits = 0;
      for (let next = 0; next < shown.length; ) {
        // The sessions whose lines are read together: on through the first whose hit keys could
        // fill the page's room, where the page may end, so no session past that is read for it.
        const groupStart = next;
        let keysAhead = 0;
        do {
          keysAhead += shown[next]?.heldHitKeys.length ?? 0;
          next += 1;
        } while (next < shown.length && hitsOffered + keysAhead <= limit);
        const group = shown.slice(groupStart, next);
        const keyLists = group.map(({ heldHitKeys }) => heldHitKeys);
        const linesOfEach =
          searchQuery === undefined
            ? this.#hitLines.readTagLines(keyLists, tagFolds, limit + 1)
            : this.#hitLines.readLines(keyLists, searchQuery, limit + 1);
        for (const [place, { session, sessionIndex, resumeAfter }] of group.entries()) {
          const hits = (linesOfEach[place] ?? []).map(shownHitOf);
          batchHits += hits.length;
          hitsOffered += hits.length;
          yield {
            sessionId: session.session_id,
            name: session.name,
            hits,
            positionAt: (shownHitCount) => ({
              sessionIndex,
              afterHitKey: shownHitCount === 0 ? resumeAfter : hits[shownHitCount - 1]?.key,
            }),
          };
        }
      }
      batchStart += sessionKeys.length;
      batchSize = nextReadBatchSize({
        room: limit - hitsOffered,
        batchHits,
        batchSessionCount: sessionKeys.length,
        batchSize,
      });
    }
  }

  // The sessions the directory holds among these keys.
  #readSessions(sessionKeys: readonly number[]): Map<number, SessionRow> {
    const sessions = new Map<number, SessionRow>();
    if (sessionKeys.length > 0) {
      for (const session of this.#sessionsByKey.iterate(JSON.stringify(sessionKeys))) {
        sessions.set(session.session_key, session);
      }
    }
    return sessions;
  }
}

// How many sessions the next read takes. The page took every session offered so far, so its room
// is the limit less their hits. A full room needs only the one session that tells where the next
// page starts, so the read is the smallest. Otherwise the last batch's hits per session tell how
// many sessions fill the room, and a batch that offered no hit tells nothing, so the read grows by
// the most it may.
function nextReadBatchSize(read: {
  readonly room: number;
  readonly batchHits: number;
  readonly batchSessionCount: number;
  readonly batchSize: number;
}): number {
  const { room, batchHits, batchSessionCount, batchSize } = read;
  const largestBatch = batchSize * READ_BATCH_GROWTH;
  if (room <= 0) {
    return FIRST_READ_BATCH_SIZE;
  }
  if (batchHits === 0) {
    return largestBatch;
  }
  const sessionsTheRoomTakes = Math.ceil((room * batchSessionCount) / batchHits) + 1;
  return Math.min(Math.max(sessionsTheRoomTakes, FIRST_READ_BATCH_SIZE), largestBatch);
}

// A page as the wire carries it; `holdSearch` answers the id of the held search the next page
// continues, called only when there is one.
function toResponse(page: SearchPage, holdSearch: () => string): SessionSearchResponse {
  return page.next === undefined
    ? { groups: page.groups, hasMore: false }
    : {
        groups: page.groups,
        hasMore: true,
        nextCursor: encodeSearchCursor(holdSearch(), page.next),
      };
}

// A hit as a page shows it: its line, and the cursor that opens its session at it.
function shownHitOf(hitLine: HitLine): ShownHit {
  const { row, marked } = hitLine;
  const cursor =
    row.logRow === undefined ? SESSION_START_CURSOR : encodeEventCursor(row.logRow.sequence);
  return { key: row.key, hit: { cursor, line: marked.line, matchRanges: marked.matchRanges } };
}
