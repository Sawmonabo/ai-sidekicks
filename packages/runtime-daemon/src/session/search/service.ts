// `session.search`: every session's hits from the full-text index, archived sessions included,
// one page at a time, so every hit is reachable while each answer stays inside its budget and one
// message. Hits are grouped by session, the sessions in the order of their best hit.
//
// Words rank by the index's BM25 order and page along it, so a page reads only the top of the
// ranking past its start and marks only its own hits. A `tag:<tag>` term keeps the sessions that
// carry that tag or one nested under it. With words and tags, the sessions' text rank and their
// tag rank (most recently active first) are merged by Reciprocal Rank Fusion. The search box names
// no session, so no relation rank takes part.

import type { Database, Statement } from "better-sqlite3";

import {
  START_OF_LOG_POSITION,
  encodeEventCursor,
  type SessionId,
} from "@ai-sidekicks/contracts/session/id";
import {
  SESSION_SEARCH_PAGE_LIMIT_MAX,
  type SearchMatchRange,
  type SessionSearchHit,
  type SessionSearchRequest,
  type SessionSearchResponse,
} from "@ai-sidekicks/contracts/session/methods";

import {
  decodeListedSearchCursor,
  decodeRankedSearchCursor,
  encodeSearchCursor,
  type ListedPagePosition,
  type RankedPagePosition,
} from "./cursor.js";
import { SessionHitReader, type RankedHit, type SearchHits } from "./hits.js";
import { assembleSearchPage, type PageCandidate, type SearchPage } from "./page.js";
import { parseSessionSearchQuery } from "./query.js";
import { fuseRankedLists } from "./rank-fusion.js";
import {
  SessionTextRanking,
  compareRankedRows,
  compareRankedSessions,
  type RankedSessionKey,
  type TextRanking,
} from "./ranking.js";

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
interface TaggedSession {
  readonly sessionId: SessionId;
  readonly name: string | null;
  readonly lastActivityAt: string;
  readonly hits: SessionSearchHit[];
}

// The hits of a session, and its name, as a page reads them.
interface SessionHitList<Hit> {
  readonly name: string | null;
  readonly hits: readonly Hit[];
}

// Sessions are read a batch at a time while a page fills, each batch four times the last. Each read
// is one pass of the index over the words, so a page takes few: one when its sessions hold a few
// hits each, three when every session holds one.
const FIRST_READ_BATCH_SIZE = 64;
const READ_BATCH_GROWTH = 4;

// A tag hit names no row of the session's log, so it opens the session at its start.
const SESSION_START_CURSOR = encodeEventCursor(START_OF_LOG_POSITION);

/** Answers `session.search` from the full-text index on the daemon's read connection. */
export class SessionSearchService {
  readonly #reader: Database;
  readonly #ranking: SessionTextRanking;
  readonly #hitReader: SessionHitReader;
  readonly #taggedSessions: Statement<{ fold: string }, TaggedSessionRow>;

  constructor(reader: Database) {
    this.#reader = reader;
    this.#ranking = new SessionTextRanking(reader);
    this.#hitReader = new SessionHitReader(reader);
    this.#taggedSessions = reader.prepare(TAGGED_SESSIONS_SQL);
  }

  /**
   * One page of the query's hits, grouped by session, from `afterCursor` when it is given; a
   * query that names nothing answers an empty last page. Every read of a page is one snapshot.
   * Throws `session.search_cursor_unresolvable` for a cursor this kind of query did not write.
   */
  search(request: SessionSearchRequest): SessionSearchResponse {
    const page = this.#reader.transaction(() => this.#readPage(request))();
    return page.next === undefined
      ? { groups: page.groups, hasMore: false }
      : { groups: page.groups, hasMore: true, nextCursor: encodeSearchCursor(page.next) };
  }

  #readPage(request: SessionSearchRequest): SearchPage {
    const { matchExpression, tagFolds } = parseSessionSearchQuery(request.query);
    const { afterCursor } = request;
    const limit = request.limit ?? SESSION_SEARCH_PAGE_LIMIT_MAX;
    if (tagFolds.length === 0) {
      if (matchExpression === undefined) {
        return { groups: [], next: undefined };
      }
      const start = afterCursor === undefined ? undefined : decodeRankedSearchCursor(afterCursor);
      const ranking = this.#ranking.rank(matchExpression);
      const searchHits = this.#hitReader.openSearch(matchExpression, ranking);
      return assembleSearchPage(rankedCandidates(ranking, searchHits, start), limit, (hits) =>
        searchHits.markHits(hits),
      );
    }
    const start = afterCursor === undefined ? undefined : decodeListedSearchCursor(afterCursor);
    const taggedSessions = this.#readTaggedSessions(tagFolds);
    if (matchExpression === undefined) {
      const tagHits = new Map(taggedSessions.map((session) => [session.sessionId, session]));
      return assembleSearchPage(
        listedCandidates(
          taggedSessions.map((session) => session.sessionId),
          start,
          (sessionIds) => pickSessions(tagHits, sessionIds),
        ),
        limit,
        (hits) => [...hits],
      );
    }
    // The tag keeps the sessions carrying it; among those the words find, each rank orders them
    // and the fused rank orders the page.
    const searchHits = this.#hitReader.openSearch(
      matchExpression,
      this.#ranking.rank(matchExpression),
    );
    const textHits = searchHits.readEveryHit(taggedSessions.map((session) => session.sessionId));
    const textOrder = [...textHits.values()]
      .flatMap((session) => session.hits.slice(0, 1))
      .sort(compareRankedSessions)
      .map((bestHit) => bestHit.sessionId);
    const tagOrder = taggedSessions
      .map((session) => session.sessionId)
      .filter((sessionId) => (textHits.get(sessionId)?.hits.length ?? 0) > 0);
    return assembleSearchPage(
      listedCandidates(fuseRankedLists([textOrder, tagOrder]), start, (sessionIds) =>
        pickSessions(textHits, sessionIds),
      ),
      limit,
      (hits) => searchHits.markHits(hits),
    );
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

// The sessions entering the ranking past `start`, a batch at a time.
function* rankedCandidates(
  ranking: TextRanking,
  searchHits: SearchHits,
  start: RankedPagePosition | undefined,
): Generator<PageCandidate<RankedHit>> {
  let batch: RankedSessionKey[] = [];
  let batchSize = FIRST_READ_BATCH_SIZE;
  for (const entry of ranking.sessionsFrom(start)) {
    batch.push(entry);
    if (batch.length >= batchSize) {
      yield* rankedBatch(searchHits, batch, start);
      batch = [];
      batchSize *= READ_BATCH_GROWTH;
    }
  }
  yield* rankedBatch(searchHits, batch, start);
}

// A batch of sessions from the ranking, each with all its hits. A session met past `start` whose
// best hit lies before it was on an earlier page, so it is passed over.
function* rankedBatch(
  searchHits: SearchHits,
  entries: readonly RankedSessionKey[],
  start: RankedPagePosition | undefined,
): Generator<PageCandidate<RankedHit>> {
  if (entries.length === 0) {
    return;
  }
  const sessions = searchHits.readHits(entries.map((entry) => entry.sessionId));
  for (const entry of entries) {
    const session = sessions.get(entry.sessionId);
    const bestHit = session?.hits[0];
    if (session === undefined || bestHit === undefined || compareRankedRows(bestHit, entry) < 0) {
      continue;
    }
    const isStart = start !== undefined && compareRankedSessions(entry, start) === 0;
    yield {
      sessionId: entry.sessionId,
      name: session.name,
      hits: session.hits,
      shownHitCount: isStart ? start.shownHitCount : 0,
      positionAt: (shownHitCount) => ({ order: "ranked", ...entry, shownHitCount }),
    };
  }
}

// Sessions in a list built whole for the page, from `start` on, their hits read a batch at a time.
function* listedCandidates<Hit>(
  sessionIds: readonly SessionId[],
  start: ListedPagePosition | undefined,
  readHits: (sessionIds: readonly SessionId[]) => ReadonlyMap<SessionId, SessionHitList<Hit>>,
): Generator<PageCandidate<Hit>> {
  let batchStart = start?.sessionIndex ?? 0;
  let batchSize = FIRST_READ_BATCH_SIZE;
  while (batchStart < sessionIds.length) {
    const batch = sessionIds.slice(batchStart, batchStart + batchSize);
    const sessions = readHits(batch);
    for (const [offset, sessionId] of batch.entries()) {
      const session = sessions.get(sessionId);
      if (session === undefined) {
        continue;
      }
      const sessionIndex = batchStart + offset;
      yield {
        sessionId,
        name: session.name,
        hits: session.hits,
        shownHitCount: sessionIndex === start?.sessionIndex ? start.shownHitCount : 0,
        positionAt: (shownHitCount) => ({ order: "listed", sessionIndex, shownHitCount }),
      };
    }
    batchStart += batch.length;
    batchSize *= READ_BATCH_GROWTH;
  }
}

function pickSessions<Session>(
  sessions: ReadonlyMap<SessionId, Session>,
  sessionIds: readonly SessionId[],
): Map<SessionId, Session> {
  const picked = new Map<SessionId, Session>();
  for (const sessionId of sessionIds) {
    const session = sessions.get(sessionId);
    if (session !== undefined) {
      picked.set(sessionId, session);
    }
  }
  return picked;
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
