// Sessions' hits for a search's words, each ranked by its place in the search's ranking, and the
// marked line of the hits a page shows. Every index row carries its owner's key, the session's or,
// on a group's row, the group's, so the rows of some sessions and their groups are read by adding
// their keys to the match; the index answers that from the keys' own entries. A row is a hit only
// while it still indexes the source row the ranking read at its rowid, and only the hits a page
// shows are marked.

import type { Database, Statement } from "better-sqlite3";

import {
  START_OF_LOG_POSITION,
  encodeEventCursor,
  type SessionId,
} from "@ai-sidekicks/contracts/session/id";
import type { SessionGroupId } from "@ai-sidekicks/contracts/session/groups";
import type { SessionSearchHit } from "@ai-sidekicks/contracts/session/methods";
import { TRANSCRIPT_SEARCH_TEXT_MAX_LEN } from "@ai-sidekicks/contracts/transcript/search";

import { indexRowidSql, narrowToOwners, ownerIdsOf } from "./index/columns.js";
import { MATCH_CLOSE_MARK, MATCH_OPEN_MARK, cutMarkedLine, readMarks } from "./marked-line.js";
import {
  compareRankedRows,
  type RankedRowKey,
  type RankedSessionScope,
  type TextRanking,
} from "./ranking.js";
import type { HeldRowCheck } from "./rowid-floors.js";

const NARROWED_ROWS_SQL = `
  SELECT rowid AS index_rowid, session_id, sequence
    FROM session_search_index WHERE session_search_index MATCH @expression`;

// Chosen rows are read in one pass of the match between their lowest and highest rowid. The index
// seeks to a rowid bound only when it is an integer, and a JavaScript number binds as a real, so
// each bound is cast. The rowid list is a filter the index never sees (`+rowid`): as a constraint
// it would run the match once per rowid, and a prefix the prefix index does not hold is gathered
// anew on each run.
const CHOSEN_ROWS_FILTER_SQL = `
     AND rowid >= CAST(@first AS INTEGER) AND rowid <= CAST(@last AS INTEGER)
     AND +rowid IN (SELECT value FROM json_each(@rowids))`;

const MARKED_ROWS_SQL = `
  SELECT rowid AS index_rowid, highlight(session_search_index, 0, @open, @close) AS marked
    FROM session_search_index
   WHERE session_search_index MATCH @expression ${CHOSEN_ROWS_FILTER_SQL}`;

// The sessions the directory holds among these, each with its group and its group's index rowid; a
// session since purged has no row, and so no hits.
const HIT_SESSIONS_SQL = `
  SELECT session.id AS session_id, session.name, session_group.id AS group_id,
         ${indexRowidSql("session_group.rowid", "group")} AS group_index_rowid
    FROM sessions AS session
    LEFT JOIN session_groups AS session_group ON session_group.id = session.group_id
   WHERE session.id IN (SELECT value FROM json_each(?))`;

// A matching index row as a read gives it.
interface MatchingRow {
  readonly index_rowid: number;
  /** `null` on a group's row, which belongs to every session in the group. */
  readonly session_id: SessionId | null;
  /** The log row's position, `null` on a title, group or tag row. */
  readonly sequence: number | null;
}

interface MarkedRow {
  readonly index_rowid: number;
  readonly marked: string;
}

// Rows a read is limited to: their lowest and highest rowid, and the list of them as JSON.
interface ChosenRows {
  readonly first: number;
  readonly last: number;
  readonly rowids: string;
}

interface HitSessionRow {
  readonly session_id: SessionId;
  readonly name: string | null;
  readonly group_id: SessionGroupId | null;
  readonly group_index_rowid: number | null;
}

/** A session whose hits are read, with its name. */
export interface HitSession extends RankedSessionScope {
  readonly name: string | null;
}

/** One matching index row, before its text is marked, as a hit of one session. */
export interface RankedHit extends RankedRowKey {
  readonly sessionId: SessionId;
  /** The session or group whose key the row carries: the group, on a group's row. */
  readonly ownerId: SessionId | SessionGroupId;
  /** The log row's position, `undefined` for a title, group or tag, which open at the start. */
  readonly sequence: number | undefined;
}

// A session the directory holds and every hit it has for a search's words, best first.
interface SessionTextHits {
  readonly sessionId: SessionId;
  readonly name: string | null;
  readonly hits: readonly RankedHit[];
}

/** One search's hits, read session by session and marked page by page. */
export interface SearchHits {
  /**
   * Each of these sessions' hits, best first; a session the directory lacks is left out. A
   * session this search already read or collected is answered from that.
   */
  readHits(sessionIds: readonly SessionId[]): Map<SessionId, SessionTextHits>;
  /**
   * Each of these sessions' hits, best first, from the matching rows they and their groups own,
   * already read.
   */
  collectHits(
    sessions: readonly HitSession[],
    rows: Iterable<MatchingRow>,
  ): Map<SessionId, SessionTextHits>;
  /** Each hit as a page shows it: the line its first match sits in, marked, and its cursor. */
  markHits(hits: readonly RankedHit[]): SessionSearchHit[];
}

// A title, group or tag hit names no row of the session's log, so it opens the session at its
// start.
const SESSION_START_CURSOR = encodeEventCursor(START_OF_LOG_POSITION);

/** Reads sessions' hits for a search's words from the full-text index. */
export class SessionHitReader {
  readonly #narrowedRows: Statement<{ expression: string }, MatchingRow>;
  readonly #markedRows: Statement<
    { expression: string; open: string; close: string } & ChosenRows,
    MarkedRow
  >;
  readonly #hitSessions: Statement<[string], HitSessionRow>;

  constructor(reader: Database) {
    this.#narrowedRows = reader.prepare(NARROWED_ROWS_SQL);
    this.#markedRows = reader.prepare(MARKED_ROWS_SQL);
    this.#hitSessions = reader.prepare(HIT_SESSIONS_SQL);
  }

  /**
   * Opens one search's hits over its ranking, which gives every rank, for one page's read;
   * `isHeldRow` tells the rows that still index what the ranking read.
   */
  openSearch(matchExpression: string, ranking: TextRanking, isHeldRow: HeldRowCheck): SearchHits {
    const heldRankOf = (indexRowid: number): number | undefined =>
      isHeldRow(indexRowid) ? ranking.rankOf(indexRowid) : undefined;
    const readSessions = new Map<SessionId, SessionTextHits>();
    const collect = (
      sessions: readonly HitSession[],
      rows: Iterable<MatchingRow>,
    ): Map<SessionId, SessionTextHits> => {
      const hitsBySession = new Map<SessionId, RankedHit[]>(
        sessions.map((session) => [session.sessionId, []]),
      );
      const groupMembers = new Map<number, HitSession[]>();
      for (const session of sessions) {
        if (session.groupIndexRowid !== null) {
          const members = groupMembers.get(session.groupIndexRowid) ?? [];
          members.push(session);
          groupMembers.set(session.groupIndexRowid, members);
        }
      }
      // A row of a session not asked about finds no list; one written after the ranking was read,
      // or at the rowid of a row deleted since, has no held rank; both are passed over.
      for (const row of rows) {
        const rank = heldRankOf(row.index_rowid);
        if (rank === undefined) {
          continue;
        }
        const sequence = row.sequence ?? undefined;
        if (row.session_id !== null) {
          const { session_id: sessionId } = row;
          hitsBySession
            .get(sessionId)
            ?.push({ rank, indexRowid: row.index_rowid, sessionId, ownerId: sessionId, sequence });
          continue;
        }
        for (const member of groupMembers.get(row.index_rowid) ?? []) {
          hitsBySession.get(member.sessionId)?.push({
            rank,
            indexRowid: row.index_rowid,
            sessionId: member.sessionId,
            ownerId: member.groupId ?? member.sessionId,
            sequence,
          });
        }
      }
      const collected = new Map<SessionId, SessionTextHits>();
      for (const session of sessions) {
        const hits = (hitsBySession.get(session.sessionId) ?? []).sort(compareRankedRows);
        const sessionHits = { sessionId: session.sessionId, name: session.name, hits };
        collected.set(session.sessionId, sessionHits);
        readSessions.set(session.sessionId, sessionHits);
      }
      return collected;
    };
    return {
      readHits: (sessionIds) => {
        const unreadSessionIds = sessionIds.filter((sessionId) => !readSessions.has(sessionId));
        if (unreadSessionIds.length > 0) {
          const sessions = this.#hitSessions.all(JSON.stringify(unreadSessionIds)).map(
            (session): HitSession => ({
              sessionId: session.session_id,
              name: session.name,
              groupId: session.group_id,
              groupIndexRowid: session.group_index_rowid,
            }),
          );
          if (sessions.length > 0) {
            collect(
              sessions,
              this.#narrowedRows.iterate({
                expression: narrowToOwners(matchExpression, ownerIdsOf(sessions)),
              }),
            );
          }
        }
        const sessions = new Map<SessionId, SessionTextHits>();
        for (const sessionId of sessionIds) {
          const session = readSessions.get(sessionId);
          if (session !== undefined) {
            sessions.set(sessionId, session);
          }
        }
        return sessions;
      },
      collectHits: collect,
      markHits: (hits) => {
        const markedRows = new Map<number, string>();
        if (hits.length > 0) {
          const ownerIds = [...new Set(hits.map((hit) => hit.ownerId))];
          for (const row of this.#markedRows.iterate({
            expression: narrowToOwners(matchExpression, ownerIds),
            ...chosenRowsOf(hits),
            open: MATCH_OPEN_MARK,
            close: MATCH_CLOSE_MARK,
          })) {
            markedRows.set(row.index_rowid, row.marked);
          }
        }
        return hits.map((hit) => markHit(hit, markedRows.get(hit.indexRowid)));
      },
    };
  }
}

// The rows of these hits, which are at least one.
function chosenRowsOf(hits: readonly RankedHit[]): ChosenRows {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const hit of hits) {
    first = Math.min(first, hit.indexRowid);
    last = Math.max(last, hit.indexRowid);
  }
  return { first, last, rowids: JSON.stringify(hits.map((hit) => hit.indexRowid)) };
}

// A page's hits and their marks come from one read transaction, and each hit matched when it was
// read, so each has a mark; one with none is a broken index, which `cutMarkedLine` throws for.
function markHit(hit: RankedHit, markedText: string | undefined): SessionSearchHit {
  const markedLine = cutMarkedLine(readMarks(markedText ?? ""), TRANSCRIPT_SEARCH_TEXT_MAX_LEN);
  const cursor =
    hit.sequence === undefined ? SESSION_START_CURSOR : encodeEventCursor(hit.sequence);
  return { cursor, ...markedLine };
}
