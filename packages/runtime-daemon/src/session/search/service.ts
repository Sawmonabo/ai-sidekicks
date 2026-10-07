// `session.search`: every session's hits from the full-text index, archived sessions included,
// one page at a time, so every hit is reachable while each answer stays inside its budget and one
// message. Hits are grouped by session, the sessions in the order of their best hit.
//
// Words rank by the index's BM25 order. The first page reads the ranking once and holds it, and
// every later page walks that held ranking, so a write between pages neither repeats nor drops a
// hit the first page's search held; a page marks only its own hits. A `tag:<tag>` term keeps the
// sessions that carry that tag or one nested under it. With words and tags, the sessions' text
// rank and their tag rank (most recently active first) are merged by Reciprocal Rank Fusion. The
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

import {
  decodeSearchCursor,
  encodeSearchCursor,
  searchCursorUnresolvable,
  type ListedPagePosition,
  type SearchPagePosition,
} from "./cursor.js";
import { SessionHitReader, type RankedHit, type SearchHits } from "./hits.js";
import { assembleSearchPage, type PageCandidate, type SearchPage } from "./page.js";
import { parseSessionSearchQuery, type ParsedSearchQuery } from "./query.js";
import { fuseRankedLists } from "./rank-fusion.js";
import { SessionTextRanking, compareRankedRows, type RankedRowKey } from "./ranking.js";
import { RowidFloorLog, type HeldRowCheck } from "./rowid-floors.js";
import { IndexRowSessions, listedSessionOrder, rankedSessionOrder } from "./session-order.js";
import {
  DEFAULT_SEARCH_SNAPSHOT_LIMITS,
  SearchSnapshots,
  listedByteLength,
  type ListedSession,
  type SearchSnapshot,
  type SearchSnapshotLimits,
  type SessionOrder,
} from "./snapshots.js";

// The sessions carrying a tag or one nested under it: the fold itself, or any fold past its `/`.
// `0` is the character after `/`, so the range holds exactly the nested folds.
const TAGGED_SESSIONS_SQL = `
  SELECT tag.session_id, tag.tag, session.name, session.last_activity_at
    FROM session_tags AS tag
    JOIN sessions AS session ON session.id = tag.session_id
   WHERE tag.tag_folded = @fold
      OR (tag.tag_folded >= @fold || '/' AND tag.tag_folded < @fold || '0')
   ORDER BY tag.tag_folded`;

interface TaggedSessionRow {
  readonly session_id: SessionId;
  readonly tag: string;
  readonly name: string | null;
  readonly last_activity_at: string;
}

// A session carrying a tag, with the tags that matched; across several queried tags, the tags
// that matched each one after another.
interface TaggedSession extends ListedSession {
  readonly lastActivityAt: string;
  readonly hits: SessionSearchHit[];
}

// A search a first page opened, and the hits it read in finding its order, when it read any.
interface OpenedSearch {
  readonly snapshot: SearchSnapshot;
  readonly searchHits?: SearchHits;
}

// A cursor read back, which a later page resumes from.
interface PageResume {
  readonly cursor: SessionSearchCursor;
  readonly position: SearchPagePosition;
}

// Sessions are read a batch at a time while a page fills, each batch four times the last. Each read
// is one pass of the index over the words, so a page takes few: one when its sessions hold a few
// hits each, three when every session holds one.
const FIRST_READ_BATCH_SIZE = 64;
const READ_BATCH_GROWTH = 4;

// A tag hit names no row of the session's log, so it opens the session at its start.
const SESSION_START_CURSOR = encodeEventCursor(START_OF_LOG_POSITION);

// Inside the read that ranked them, every row is still the row the ranking read.
const EVERY_ROW_HELD: HeldRowCheck = () => true;

/** Answers `session.search` from the full-text index on the daemon's read connection. */
export class SessionSearchService {
  readonly #reader: Database;
  readonly #ranking: SessionTextRanking;
  readonly #floorLog: RowidFloorLog;
  readonly #rowSessions: IndexRowSessions;
  readonly #hitReader: SessionHitReader;
  readonly #taggedSessions: Statement<{ fold: string }, TaggedSessionRow>;
  readonly #snapshots: SearchSnapshots;

  constructor(
    reader: Database,
    snapshotLimits: SearchSnapshotLimits = DEFAULT_SEARCH_SNAPSHOT_LIMITS,
  ) {
    this.#reader = reader;
    this.#ranking = new SessionTextRanking(reader);
    this.#floorLog = new RowidFloorLog(reader);
    this.#rowSessions = new IndexRowSessions(reader);
    this.#hitReader = new SessionHitReader(reader);
    this.#taggedSessions = reader.prepare(TAGGED_SESSIONS_SQL);
    this.#snapshots = new SearchSnapshots(snapshotLimits);
  }

  /**
   * One page of the query's hits, grouped by session, from `afterCursor` when it is given; a
   * query that names nothing answers an empty last page. A page is read in one read transaction,
   * and every page after the first reads what the first one held. Throws
   * `session.search_cursor_unresolvable` for a cursor that continues no search held for this
   * query.
   */
  search(request: SessionSearchRequest): SessionSearchResponse {
    return this.#reader.transaction(() => this.#answer(request))();
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
    const opened = this.#openSearch(query, queryKey);
    if (opened === undefined) {
      return { groups: [], hasMore: false };
    }
    const { snapshot, searchHits } = opened;
    // A search answered whole on its first page has no later page to hold it for.
    return toResponse(this.#readHeldPage(snapshot, limit, undefined, searchHits), () =>
      this.#snapshots.hold(snapshot),
    );
  }

  // The search a first page reads: its ranking or its whole answer, held for its later pages, and
  // the hits already read in finding its order, which the first page reuses.
  #openSearch(query: ParsedSearchQuery, queryKey: string): OpenedSearch | undefined {
    const { matchExpression, tagFolds } = query;
    if (tagFolds.length === 0) {
      if (matchExpression === undefined) {
        return undefined;
      }
      const ranking = this.#ranking.rank(matchExpression);
      return {
        snapshot: {
          order: "ranked",
          queryKey,
          matchExpression,
          ranking,
          floorPosition: this.#floorLog.position(),
          sessionOrder: rankedSessionOrder(ranking, this.#rowSessions),
        },
      };
    }
    const taggedSessions = this.#readTaggedSessions(tagFolds);
    if (matchExpression === undefined) {
      const sessions = taggedSessions.map(({ sessionId, name, hits }) => ({
        sessionId,
        name,
        hits,
      }));
      return {
        snapshot: { order: "listed", queryKey, sessions, byteLength: listedByteLength(sessions) },
      };
    }
    // The tag keeps the sessions carrying it; among those the words find, each rank orders them
    // and the fused rank orders the pages.
    const ranking = this.#ranking.rank(matchExpression);
    const searchHits = this.#hitReader.openSearch(matchExpression, ranking, EVERY_ROW_HELD);
    const textHits = searchHits.readEveryHit(taggedSessions.map((session) => session.sessionId));
    const textOrder = [...textHits.values()]
      .flatMap((session) => session.hits.slice(0, 1))
      .sort(compareRankedRows)
      .map((bestHit) => bestHit.sessionId);
    const tagOrder = taggedSessions
      .map((session) => session.sessionId)
      .filter((sessionId) => (textHits.get(sessionId)?.hits.length ?? 0) > 0);
    return {
      snapshot: {
        order: "ranked",
        queryKey,
        matchExpression,
        ranking,
        floorPosition: this.#floorLog.position(),
        sessionOrder: listedSessionOrder(fuseRankedLists([textOrder, tagOrder])),
      },
      searchHits,
    };
  }

  // A page of a held search, from where `resume` names when a cursor continues it. Throws
  // `session.search_cursor_unresolvable` for a position the search could not have written, and
  // once the rowid floor log no longer tells which held rows later rows took.
  #readHeldPage(
    snapshot: SearchSnapshot,
    limit: number,
    resume: PageResume | undefined,
    openedHits?: SearchHits,
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
    const start = resume?.position.order === "ranked" ? resume.position : undefined;
    let afterHit: RankedRowKey | undefined;
    if (resume !== undefined && start?.afterHitRowid !== undefined) {
      const rank = snapshot.ranking.rankOf(start.afterHitRowid);
      if (rank === undefined) {
        throw searchCursorUnresolvable(resume.cursor);
      }
      afterHit = { rank, indexRowid: start.afterHitRowid };
    }
    const isHeldRow = this.#heldRowCheck(snapshot.floorPosition, resume);
    const searchHits =
      openedHits ??
      this.#hitReader.openSearch(snapshot.matchExpression, snapshot.ranking, isHeldRow);
    return assembleSearchPage(
      rankedCandidates(
        snapshot.sessionOrder,
        searchHits,
        isHeldRow,
        start?.sessionIndex ?? 0,
        afterHit,
      ),
      limit,
      (hits) => searchHits.markHits(hits),
    );
  }

  // Which held rows a page may still credit. The first page reads inside the ranking's own read; a
  // later page asks the floor log, and is refused once the log has let go of what it needs.
  #heldRowCheck(floorPosition: number, resume: PageResume | undefined): HeldRowCheck {
    if (resume === undefined) {
      return EVERY_ROW_HELD;
    }
    const isHeldRow = this.#floorLog.heldRowCheck(floorPosition);
    if (isHeldRow === undefined) {
      throw searchCursorUnresolvable(resume.cursor);
    }
    return isHeldRow;
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
    return sessions.sort(
      (left, right) =>
        right.lastActivityAt.localeCompare(left.lastActivityAt) ||
        (left.sessionId < right.sessionId ? -1 : 1),
    );
  }

  // The sessions carrying the tag or one nested under it, each with the tags that matched.
  #readTagMatches(fold: string): Map<SessionId, TaggedSession> {
    const queriedSegmentCount = fold.split("/").length;
    const bySession = new Map<SessionId, TaggedSession>();
    for (const row of this.#taggedSessions.all({ fold })) {
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

// The sessions of the order from `firstIndex` on, a batch at a time, each with its hits; the first
// with only those after `afterHit`, the last hit an earlier page showed. A hit keeps the rank the
// ranking held, so the hits after it are the same on every read; a session since purged has none,
// and is passed over. The order reads past the rows `isHeldRow` refuses.
function* rankedCandidates(
  sessionOrder: SessionOrder,
  searchHits: SearchHits,
  isHeldRow: HeldRowCheck,
  firstIndex: number,
  afterHit: RankedRowKey | undefined,
): Generator<PageCandidate<RankedHit>> {
  let sessionIndex = firstIndex;
  let batchSize = FIRST_READ_BATCH_SIZE;
  for (;;) {
    const batch: { readonly sessionIndex: number; readonly sessionId: SessionId }[] = [];
    while (batch.length < batchSize) {
      const sessionId = sessionOrder.sessionAt(sessionIndex, isHeldRow);
      if (sessionId === undefined) {
        break;
      }
      batch.push({ sessionIndex, sessionId });
      sessionIndex += 1;
    }
    if (batch.length === 0) {
      return;
    }
    const sessions = searchHits.readHits(batch.map((entry) => entry.sessionId));
    for (const entry of batch) {
      const session = sessions.get(entry.sessionId);
      if (session === undefined) {
        continue;
      }
      const resumeAfter = entry.sessionIndex === firstIndex ? afterHit : undefined;
      const hits = session.hits.filter(
        (hit) => resumeAfter === undefined || compareRankedRows(hit, resumeAfter) > 0,
      );
      yield {
        sessionId: entry.sessionId,
        name: session.name,
        hits,
        shownHitCount: 0,
        positionAt: (shownHitCount) => ({
          order: "ranked",
          sessionIndex: entry.sessionIndex,
          afterHitRowid:
            shownHitCount === 0 ? resumeAfter?.indexRowid : hits[shownHitCount - 1]?.indexRowid,
        }),
      };
    }
    batchSize *= READ_BATCH_GROWTH;
  }
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
