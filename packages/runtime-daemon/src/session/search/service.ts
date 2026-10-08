// `session.search`: every session's hits from the search index, archived sessions included, one
// page at a time, so every hit is reachable while each answer stays inside its budget and one
// message. Hits are grouped by session, the sessions in the order of their best hit.
//
// Words rank by the index's BM25 order. The first page opens a view of the index and holds it, and
// every later page reads that view, so a write between pages neither repeats nor drops a hit the
// view held. A hit's line is read from the database by its key and marked on the row's text as it
// is now: a hit whose row is gone is passed over, and so is one whose rowid a later row has taken
// since the view, which the rowid floor log tells. A `tag:<tag>` term keeps the sessions that carry
// that tag or one nested under it. With words and tags, the index ranks only the tagged sessions'
// rows, and their text rank and their tag rank (most recently active first) are merged by
// Reciprocal Rank Fusion; names, groups and lines are read only for a page's own sessions. The
// search box names no session, so no relation rank takes part.

import type { Database, Statement } from "better-sqlite3";

import {
  START_OF_LOG_POSITION,
  encodeEventCursor,
  type SessionId,
} from "@ai-sidekicks/contracts/session/id";
import {
  SESSION_SEARCH_PAGE_LIMIT_MAX,
  type SearchMatchRange,
  type SessionSearchCursor,
  type SessionSearchHit,
  type SessionSearchRequest,
  type SessionSearchResponse,
} from "@ai-sidekicks/contracts/session/methods";
import type { SearchIndex } from "@ai-sidekicks/search-index";

import {
  decodeSearchCursor,
  encodeSearchCursor,
  searchCursorUnresolvable,
  type ListedPagePosition,
  type SearchPagePosition,
} from "./cursor.js";
import { HitLineReader, type HitLine } from "./hits.js";
import { indexKeyOf } from "./index/columns.js";
import type { IndexRowReader } from "./index/rows.js";
import { assembleSearchPage, type PageCandidate, type SearchPage } from "./page.js";
import { parseSessionSearchQuery, type ParsedSearchQuery } from "./query.js";
import { fuseRankedLists } from "./rank-fusion.js";
import type { HeldRowCheck, RowidFloorLog } from "./rowid-floors.js";
import {
  DEFAULT_SEARCH_SNAPSHOT_LIMITS,
  SearchSnapshots,
  releaseSearch,
  type ListedSession,
  type SearchSnapshot,
  type SearchSnapshotLimits,
} from "./snapshots.js";

// A tag row carrying the tag `@fold` or one nested under it: the fold itself, or any fold past its
// `/`. `0` is the character after `/`, so the range holds exactly the nested folds.
const TAG_FOLD_MATCH_SQL = `(tag.tag_folded = @fold
      OR (tag.tag_folded >= @fold || '/' AND tag.tag_folded < @fold || '0'))`;

// The sessions carrying a tag or one nested under it, with the tags that matched, for a search by
// tag alone.
const TAGGED_SESSIONS_SQL = `
  SELECT tag.session_id, tag.tag, session.name, session.last_activity_at
    FROM session_tags AS tag
    JOIN sessions AS session ON session.id = tag.session_id
   WHERE ${TAG_FOLD_MATCH_SQL}
   ORDER BY tag.tag_folded`;

// The same sessions by key with their last activity, for a search by tag and words: read from the
// tag index and the sessions' activity index alone, with no name or group.
const TAGGED_SESSION_KEYS_SQL = `
  SELECT DISTINCT session.rowid AS session_key, session.id AS session_id, session.last_activity_at
    FROM session_tags AS tag
    JOIN sessions AS session ON session.id = tag.session_id
   WHERE ${TAG_FOLD_MATCH_SQL}`;

// The sessions the directory holds among these keys; a session since purged has no row.
const SESSIONS_BY_KEY_SQL = `
  SELECT rowid AS session_key, id AS session_id, name
    FROM sessions WHERE rowid IN (SELECT value FROM json_each(?))`;

interface TaggedSessionRow {
  readonly session_id: SessionId;
  readonly tag: string;
  readonly name: string | null;
  readonly last_activity_at: string;
}

interface TaggedSessionKeyRow {
  readonly session_key: number;
  readonly session_id: SessionId;
  readonly last_activity_at: string;
}

interface SessionRow {
  readonly session_key: number;
  readonly session_id: SessionId;
  readonly name: string | null;
}

// A session carrying the queried tags, as a search by tag orders it.
interface ActiveSession {
  readonly sessionId: SessionId;
  readonly lastActivityAt: string;
}

// A session carrying a queried tag, with the tags that matched as its hits.
interface TaggedSession extends ListedSession, ActiveSession {
  readonly hits: SessionSearchHit[];
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

// Sessions are read a batch at a time while a page fills, each batch four times the last. A read
// costs what its sessions' hits cost, so a small first batch keeps a page of sessions that each
// hold many hits from reading hits it never shows, and a page of sessions with one hit each still
// takes three reads.
const FIRST_READ_BATCH_SIZE = 16;
const READ_BATCH_GROWTH = 4;

// A title, group or tag hit names no row of the session's log, so it opens the session at its
// start.
const SESSION_START_CURSOR = encodeEventCursor(START_OF_LOG_POSITION);

/** What `session.search` reads: the daemon's read connection and the search index. */
export interface SessionSearchServiceDeps {
  readonly reader: Database;
  readonly index: Pick<SearchIndex, "openSearch" | "markMatches">;
  readonly rows: IndexRowReader;
  readonly floorLog: RowidFloorLog;
  /**
   * Where the rowid floor log stood when the index last matched the database; a search opened now
   * checks its rows from there.
   */
  readonly appliedFloorPosition: () => number;
  readonly limits?: SearchSnapshotLimits;
}

/** Answers `session.search` from the search index and the daemon's read connection. */
export class SessionSearchService {
  readonly #reader: Database;
  readonly #index: Pick<SearchIndex, "openSearch">;
  readonly #floorLog: RowidFloorLog;
  readonly #appliedFloorPosition: () => number;
  readonly #hitLines: HitLineReader;
  readonly #sessionsByKey: Statement<[string], SessionRow>;
  readonly #taggedSessions: Statement<{ fold: string }, TaggedSessionRow>;
  readonly #taggedSessionKeys: Statement<{ fold: string }, TaggedSessionKeyRow>;
  readonly #snapshots: SearchSnapshots;

  constructor(deps: SessionSearchServiceDeps) {
    this.#reader = deps.reader;
    this.#index = deps.index;
    this.#floorLog = deps.floorLog;
    this.#appliedFloorPosition = deps.appliedFloorPosition;
    this.#hitLines = new HitLineReader(deps.rows, deps.index);
    this.#sessionsByKey = deps.reader.prepare(SESSIONS_BY_KEY_SQL);
    this.#taggedSessions = deps.reader.prepare(TAGGED_SESSIONS_SQL);
    this.#taggedSessionKeys = deps.reader.prepare(TAGGED_SESSION_KEYS_SQL);
    this.#snapshots = new SearchSnapshots(deps.limits ?? DEFAULT_SEARCH_SNAPSHOT_LIMITS);
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
    const page = this.#readHeldPage(snapshot, limit, undefined);
    // A search answered whole on its first page has no later page to hold it for.
    if (page.next === undefined) {
      releaseSearch(snapshot);
    }
    return toResponse(page, () => this.#snapshots.hold(snapshot));
  }

  // The search a first page opens: a view of the index with its order of sessions, or a search by
  // tag alone's whole answer; `undefined` when it can find nothing.
  #openSearch(query: ParsedSearchQuery, queryKey: string): SearchSnapshot | undefined {
    const { searchQuery, tagFolds } = query;
    if (searchQuery === undefined) {
      if (tagFolds.length === 0) {
        return undefined;
      }
      const sessions = this.#readTaggedSessions(tagFolds).map(({ sessionId, name, hits }) => ({
        sessionId,
        name,
        hits,
      }));
      return { order: "listed", queryKey, sessions };
    }
    // Read before the view opens, so it is never newer than the view.
    const floorPosition = this.#appliedFloorPosition();
    if (tagFolds.length === 0) {
      const view = this.#index.openSearch(searchQuery);
      return {
        order: "ranked",
        queryKey,
        searchQuery,
        view,
        floorPosition,
        sessionOrder: { sessionsAt: (from, count) => view.sessionsAt(from, count) },
      };
    }
    // The tag keeps the sessions carrying it, and only their rows are ranked; among those the words
    // find, each rank orders them and the fused rank orders the pages.
    const taggedKeys = this.#readTaggedSessionKeys(tagFolds);
    if (taggedKeys.length === 0) {
      return undefined;
    }
    const view = this.#index.openSearch(searchQuery, taggedKeys);
    const textOrder = view.sessionsAt(0, taggedKeys.length);
    const textMatched = new Set(textOrder);
    const tagOrder = taggedKeys.filter((sessionKey) => textMatched.has(sessionKey));
    const fusedOrder = fuseRankedLists([textOrder, tagOrder]);
    return {
      order: "ranked",
      queryKey,
      searchQuery,
      view,
      floorPosition,
      sessionOrder: { sessionsAt: (from, count) => fusedOrder.slice(from, from + count) },
    };
  }

  // A page of a held search, from where `resume` names when a cursor continues it. Throws
  // `session.search_cursor_unresolvable` for a position the search could not have written.
  #readHeldPage(
    snapshot: SearchSnapshot,
    limit: number,
    resume: PageResume | undefined,
  ): SearchPage {
    if (snapshot.order === "listed") {
      if (resume !== undefined && resume.position.order !== "listed") {
        throw searchCursorUnresolvable(resume.cursor);
      }
      const start = resume?.position.order === "listed" ? resume.position : undefined;
      return assembleSearchPage(listedCandidates(snapshot.sessions, start), limit, (hits) => [
        ...hits,
      ]);
    }
    if (resume !== undefined && resume.position.order !== "ranked") {
      throw searchCursorUnresolvable(resume.cursor);
    }
    const candidates = this.#rankedCandidates(
      snapshot,
      this.#floorLog.heldRowCheck(snapshot.floorPosition),
      resume,
      limit,
    );
    return assembleSearchPage(candidates, limit, (hits) => hits.map((shown) => shown.hit));
  }

  // The sessions of a held search's order from where `resume` names on, a batch at a time, each
  // with its hits that still hold a match, read one past what a page holds so a session with more
  // splits across pages; the first with only those after the last hit an earlier page showed. A
  // session since purged, or one whose rowid a later session took, is passed over, and so is a hit
  // whose row is gone or was taken. Throws `session.search_cursor_unresolvable` when the cursor's
  // hit is none of its session's hits.
  *#rankedCandidates(
    snapshot: Extract<SearchSnapshot, { readonly order: "ranked" }>,
    isHeldRow: HeldRowCheck,
    resume: PageResume | undefined,
    limit: number,
  ): Generator<PageCandidate<ShownHit>> {
    const start = resume?.position.order === "ranked" ? resume.position : undefined;
    const firstIndex = start?.sessionIndex ?? 0;
    let batchStart = firstIndex;
    let batchSize = FIRST_READ_BATCH_SIZE;
    for (;;) {
      const sessionKeys = snapshot.sessionOrder.sessionsAt(batchStart, batchSize);
      if (sessionKeys.length === 0) {
        return;
      }
      const sessions = this.#readSessions(
        sessionKeys.filter((sessionKey) => isHeldRow(indexKeyOf(sessionKey, "title"))),
      );
      const heldKeys = sessionKeys.filter((sessionKey) => sessions.has(sessionKey));
      const hitKeysOfHeld = heldKeys.length === 0 ? [] : snapshot.view.hitsOf(heldKeys);
      const hitKeysBySession = new Map(
        heldKeys.map((sessionKey, index) => [sessionKey, hitKeysOfHeld[index] ?? []]),
      );
      for (const [offset, sessionKey] of sessionKeys.entries()) {
        const session = sessions.get(sessionKey);
        if (session === undefined) {
          continue;
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
        const hits = this.#hitLines
          .readLines(hitKeys.filter(isHeldRow), snapshot.searchQuery, limit + 1)
          .map(shownHitOf);
        yield {
          sessionId: session.session_id,
          name: session.name,
          hits,
          shownHitCount: 0,
          positionAt: (shownHitCount) => ({
            order: "ranked",
            sessionIndex,
            afterHitKey: shownHitCount === 0 ? resumeAfter : hits[shownHitCount - 1]?.key,
          }),
        };
      }
      batchStart += sessionKeys.length;
      batchSize *= READ_BATCH_GROWTH;
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

  // The sessions carrying every queried tag, most recently active first, each with the tags that
  // matched as its hits.
  #readTaggedSessions(tagFolds: readonly string[]): TaggedSession[] {
    const [firstMatches, ...otherMatches] = tagFolds.map((fold) => this.#readTagMatches(fold));
    if (firstMatches === undefined) {
      return [];
    }
    const sessions: TaggedSession[] = [];
    for (const [sessionId, session] of firstMatches) {
      const others = otherMatches.map((matches) => matches.get(sessionId));
      if (others.every((other) => other !== undefined)) {
        sessions.push({
          ...session,
          hits: [session, ...others].flatMap((matched) => matched.hits),
        });
      }
    }
    return sessions.sort(compareByActivity);
  }

  // The sessions carrying the tag or one nested under it, each with the tags that matched.
  #readTagMatches(fold: string): Map<SessionId, TaggedSession> {
    const queriedSegmentCount = fold.split("/").length;
    const bySession = new Map<SessionId, TaggedSession>();
    for (const row of this.#taggedSessions.iterate({ fold })) {
      let session = bySession.get(row.session_id);
      if (session === undefined) {
        session = {
          sessionId: row.session_id,
          name: row.name,
          lastActivityAt: row.last_activity_at,
          hits: [],
        };
        bySession.set(row.session_id, session);
      }
      session.hits.push({
        cursor: SESSION_START_CURSOR,
        line: row.tag,
        matchRanges: [leadingSegmentsRange(row.tag, queriedSegmentCount)],
      });
    }
    return bySession;
  }

  // The keys of the sessions carrying every queried tag, most recently active first.
  #readTaggedSessionKeys(tagFolds: readonly string[]): number[] {
    const [firstMatches, ...otherMatches] = tagFolds.map((fold) => {
      const bySession = new Map<number, ActiveSession>();
      for (const row of this.#taggedSessionKeys.iterate({ fold })) {
        bySession.set(row.session_key, {
          sessionId: row.session_id,
          lastActivityAt: row.last_activity_at,
        });
      }
      return bySession;
    });
    if (firstMatches === undefined) {
      return [];
    }
    return [...firstMatches]
      .filter(([sessionKey]) => otherMatches.every((matches) => matches.has(sessionKey)))
      .sort(([, left], [, right]) => compareByActivity(left, right))
      .map(([sessionKey]) => sessionKey);
  }
}

// Most recently active first, then by id, so equal times keep one order.
function compareByActivity(left: ActiveSession, right: ActiveSession): number {
  if (left.lastActivityAt !== right.lastActivityAt) {
    return left.lastActivityAt > right.lastActivityAt ? -1 : 1;
  }
  return left.sessionId < right.sessionId ? -1 : 1;
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

// The sessions of a search by tag alone from `start` on, all already in hand.
function* listedCandidates(
  sessions: readonly ListedSession[],
  start: ListedPagePosition | undefined,
): Generator<PageCandidate<SessionSearchHit>> {
  const firstIndex = start?.sessionIndex ?? 0;
  for (const [offset, session] of sessions.slice(firstIndex).entries()) {
    const sessionIndex = firstIndex + offset;
    yield {
      sessionId: session.sessionId,
      name: session.name,
      hits: session.hits,
      shownHitCount: offset === 0 ? (start?.shownHitCount ?? 0) : 0,
      positionAt: (shownHitCount) => ({ order: "listed", sessionIndex, shownHitCount }),
    };
  }
}

// The stretch of a tag the query named: its first segments, as many as the query's tag has.
function leadingSegmentsRange(tag: string, segmentCount: number): SearchMatchRange {
  let end = -1;
  for (let segment = 0; segment < segmentCount; segment += 1) {
    end = tag.indexOf("/", end + 1);
    if (end === -1) {
      return { start: 0, end: tag.length };
    }
  }
  return { start: 0, end };
}
