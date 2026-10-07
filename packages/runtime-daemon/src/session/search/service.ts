// `session.search`: every session's hits from the full-text index, archived sessions included,
// with no cap. Words rank by the index's BM25 order; a `tag:<tag>` term keeps the sessions that
// carry that tag or one nested under it. Hits are grouped by session, the sessions in the order
// of their best hit.

import type { Database, Statement } from "better-sqlite3";

import {
  START_OF_LOG_POSITION,
  encodeEventCursor,
  type SessionId,
} from "@ai-sidekicks/contracts/session/id";
import type {
  SearchMatchRange,
  SessionSearchGroup,
  SessionSearchHit,
  SessionSearchRequest,
  SessionSearchResponse,
} from "@ai-sidekicks/contracts/session/methods";
import { TRANSCRIPT_SEARCH_TEXT_MAX_LEN } from "@ai-sidekicks/contracts/transcript/search";

import { MATCH_CLOSE_MARK, MATCH_OPEN_MARK, readMarkedLine } from "./marked-line.js";
import { parseSessionSearchQuery } from "./query.js";

// Each matching row in BM25 order, a group's row once for every session in that group. Only rows
// whose session the directory holds are hits.
const TEXT_HITS_SQL = `
  WITH ranked AS MATERIALIZED (
    SELECT index_row.rowid AS index_rowid, index_row.kind, index_row.session_id,
           index_row.sequence, index_row.rank,
           highlight(session_search_index, 0, @open, @close) AS marked
      FROM session_search_index AS index_row
     WHERE session_search_index MATCH @expression
  )
  SELECT session.id AS session_id, session.name, ranked.kind, ranked.sequence, ranked.marked,
         ranked.rank
    FROM ranked JOIN sessions AS session ON session.id = ranked.session_id
  UNION ALL
  SELECT session.id, session.name, ranked.kind, NULL, ranked.marked, ranked.rank
    FROM ranked
    JOIN session_groups AS session_group ON session_group.rowid = (ranked.index_rowid - 2) / 4
    JOIN sessions AS session ON session.group_id = session_group.id
   WHERE ranked.kind = 'group'
   ORDER BY rank, session_id`;

// The sessions carrying a tag or one nested under it: the fold itself, or any fold past its `/`.
// `0` is the character after `/`, so the range holds exactly the nested folds.
const TAGGED_SESSIONS_SQL = `
  SELECT session_id, tag, tag_folded FROM session_tags
   WHERE tag_folded = @fold OR (tag_folded >= @fold || '/' AND tag_folded < @fold || '0')`;

const SESSION_FACTS_SQL = `SELECT name, last_activity_at FROM sessions WHERE id = ?`;

interface TextHitRow {
  readonly session_id: SessionId;
  readonly name: string | null;
  readonly kind: "event" | "title" | "group" | "tag";
  readonly sequence: number | null;
  readonly marked: string;
}

interface TaggedSessionRow {
  readonly session_id: SessionId;
  readonly tag: string;
  readonly tag_folded: string;
}

interface SessionFactsRow {
  readonly name: string | null;
  readonly last_activity_at: string;
}

// A title, group or tag hit names no row of the session's log, so it opens the session at its
// start.
const SESSION_START_CURSOR = encodeEventCursor(START_OF_LOG_POSITION);

/** Answers `session.search` from the full-text index on the daemon's read connection. */
export class SessionSearchService {
  readonly #textHits: Statement<{ expression: string; open: string; close: string }, TextHitRow>;
  readonly #taggedSessions: Statement<{ fold: string }, TaggedSessionRow>;
  readonly #sessionFacts: Statement<[string], SessionFactsRow>;

  constructor(reader: Database) {
    this.#textHits = reader.prepare(TEXT_HITS_SQL);
    this.#taggedSessions = reader.prepare(TAGGED_SESSIONS_SQL);
    this.#sessionFacts = reader.prepare(SESSION_FACTS_SQL);
  }

  /** Every hit for the query, grouped by session; a query that names nothing answers no group. */
  search(request: SessionSearchRequest): SessionSearchResponse {
    const { matchExpression, tagFolds } = parseSessionSearchQuery(request.query);
    const tagMatches = tagFolds.map((fold) => this.#readTaggedSessions(fold));
    const taggedSessionIds = intersectSessions(tagMatches);
    if (matchExpression === undefined) {
      return taggedSessionIds === undefined
        ? { groups: [] }
        : { groups: this.#groupTagHits(taggedSessionIds, tagMatches, tagFolds) };
    }
    const groups = new Map<SessionId, SessionSearchGroup>();
    const rows = this.#textHits.all({
      expression: matchExpression,
      open: MATCH_OPEN_MARK,
      close: MATCH_CLOSE_MARK,
    });
    for (const row of rows) {
      if (taggedSessionIds !== undefined && !taggedSessionIds.has(row.session_id)) {
        continue;
      }
      const markedLine = readMarkedLine(row.marked, TRANSCRIPT_SEARCH_TEXT_MAX_LEN);
      if (markedLine === undefined) {
        continue;
      }
      const cursor =
        row.kind === "event" && row.sequence !== null
          ? encodeEventCursor(row.sequence)
          : SESSION_START_CURSOR;
      groupOf(groups, row.session_id, row.name).hits.push({ cursor, ...markedLine });
    }
    return { groups: [...groups.values()] };
  }

  #readTaggedSessions(fold: string): Map<SessionId, TaggedSessionRow[]> {
    const bySession = new Map<SessionId, TaggedSessionRow[]>();
    for (const row of this.#taggedSessions.all({ fold })) {
      const rowsOfSession = bySession.get(row.session_id) ?? [];
      rowsOfSession.push(row);
      bySession.set(row.session_id, rowsOfSession);
    }
    return bySession;
  }

  // A search by tag alone: each session's matching tags are its hits, the sessions most recently
  // active first.
  #groupTagHits(
    sessionIds: ReadonlySet<SessionId>,
    tagMatches: readonly Map<SessionId, TaggedSessionRow[]>[],
    tagFolds: readonly string[],
  ): SessionSearchGroup[] {
    const sessions: { readonly group: SessionSearchGroup; readonly lastActivityAt: string }[] = [];
    for (const sessionId of sessionIds) {
      const facts = this.#sessionFacts.get(sessionId);
      if (facts === undefined) {
        continue;
      }
      const hits: SessionSearchHit[] = [];
      tagMatches.forEach((bySession, tagIndex) => {
        const queriedSegmentCount = (tagFolds[tagIndex] ?? "").split("/").length;
        for (const row of bySession.get(sessionId) ?? []) {
          hits.push({
            cursor: SESSION_START_CURSOR,
            line: row.tag,
            matchRanges: [leadingSegmentsRange(row.tag, queriedSegmentCount)],
          });
        }
      });
      sessions.push({
        group: { sessionId, ...nameMember(facts.name), hits },
        lastActivityAt: facts.last_activity_at,
      });
    }
    return sessions
      .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt))
      .map((session) => session.group);
  }
}

// The sessions every tag term matched; `undefined` when the query names no tag.
function intersectSessions(
  tagMatches: readonly Map<SessionId, TaggedSessionRow[]>[],
): Set<SessionId> | undefined {
  const [first, ...rest] = tagMatches;
  if (first === undefined) {
    return undefined;
  }
  return new Set([...first.keys()].filter((sessionId) => rest.every((map) => map.has(sessionId))));
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

function groupOf(
  groups: Map<SessionId, SessionSearchGroup>,
  sessionId: SessionId,
  name: string | null,
): SessionSearchGroup {
  let group = groups.get(sessionId);
  if (group === undefined) {
    group = { sessionId, ...nameMember(name), hits: [] };
    groups.set(sessionId, group);
  }
  return group;
}

// An untitled session's group carries no `name` member at all.
function nameMember(name: string | null): { name?: string } {
  return name === null ? {} : { name };
}
