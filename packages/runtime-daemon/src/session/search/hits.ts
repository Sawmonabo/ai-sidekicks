// Sessions' hits for a search's words, each ranked by its place in the search's ranking, and the
// marked line of the hits a page shows. A log row carries its session's key in the index, so the
// sessions' log rows are read, marked, by adding their keys to the match; the index answers that
// from the keys' own entries. A title, group or tag row carries no key, so it is found by its
// rowid, which its source row gives, and the ranking already holds its mark.

import type { Database, Statement } from "better-sqlite3";

import {
  START_OF_LOG_POSITION,
  encodeEventCursor,
  type SessionId,
} from "@ai-sidekicks/contracts/session/id";
import type { SessionSearchHit } from "@ai-sidekicks/contracts/session/methods";
import { TRANSCRIPT_SEARCH_TEXT_MAX_LEN } from "@ai-sidekicks/contracts/transcript/search";

import { indexRowidSql, sessionKeyOf, sourceRowidSql } from "./index-columns.js";
import { MATCH_CLOSE_MARK, MATCH_OPEN_MARK, readMarkedLine } from "./marked-line.js";
import { compareRankedRows, type RankedRowKey, type TextRanking } from "./ranking.js";

const NARROWED_EVENT_ROWS_SQL = `
  SELECT rowid AS index_rowid, session_id, sequence,
         highlight(session_search_index, 0, @open, @close) AS marked
    FROM session_search_index WHERE session_search_index MATCH @expression`;

// The log rows behind index rows, for a search that ranks every session the words find. Each is
// found by its own rowid, so no pass over the index repeats; the rows a page shows are marked
// afterwards.
const EVENT_ROWS_SQL = `
  SELECT ${indexRowidSql("event.rowid", "event")} AS index_rowid, event.session_id,
         event.sequence, NULL AS marked
    FROM json_each(?) AS wanted
    JOIN session_events AS event ON event.rowid = ${sourceRowidSql("wanted.value", "event")}`;

// The rowids each session's title, group and tag rows would have; a session the directory does not
// hold has none, and so no hits.
const OTHER_ROWIDS_SQL = `
  SELECT session.id AS session_id, session.name,
         ${indexRowidSql("session.rowid", "title")} AS title_index_rowid,
         ${indexRowidSql("session_group.rowid", "group")} AS group_index_rowid,
         (SELECT json_group_array(${indexRowidSql("tag.rowid", "tag")})
            FROM session_tags AS tag WHERE tag.session_id = session.id) AS tag_index_rowids
    FROM sessions AS session
    LEFT JOIN session_groups AS session_group ON session_group.id = session.group_id
   WHERE session.id IN (SELECT value FROM json_each(?))`;

interface EventRow {
  readonly index_rowid: number;
  readonly session_id: SessionId;
  readonly sequence: number;
  readonly marked: string | null;
}

interface OtherRowidsRow {
  readonly session_id: SessionId;
  readonly name: string | null;
  readonly title_index_rowid: number;
  readonly group_index_rowid: number | null;
  /** A JSON array of the session's tag rows' rowids. */
  readonly tag_index_rowids: string;
}

/** One matching index row, before its text is marked, as a hit of one session. */
export interface RankedHit extends RankedRowKey {
  readonly sessionId: SessionId;
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
  /** Every hit each of these sessions has, best first; a session the directory lacks is left out. */
  readHits(sessionIds: readonly SessionId[]): Map<SessionId, SessionTextHits>;
  /** Every hit each of these sessions has, read from every matching log row's own row. */
  readEveryHit(sessionIds: readonly SessionId[]): Map<SessionId, SessionTextHits>;
  /** Each hit as a page shows it: the line its first match sits in, marked, and its cursor. */
  markHits(hits: readonly RankedHit[]): SessionSearchHit[];
}

// A title, group or tag hit names no row of the session's log, so it opens the session at its
// start.
const SESSION_START_CURSOR = encodeEventCursor(START_OF_LOG_POSITION);

/** Reads sessions' hits for a search's words from the full-text index. */
export class SessionHitReader {
  readonly #narrowedEventRows: Statement<
    { expression: string; open: string; close: string },
    EventRow
  >;
  readonly #eventRows: Statement<[string], EventRow>;
  readonly #otherRowids: Statement<[string], OtherRowidsRow>;

  constructor(reader: Database) {
    this.#narrowedEventRows = reader.prepare(NARROWED_EVENT_ROWS_SQL);
    this.#eventRows = reader.prepare(EVENT_ROWS_SQL);
    this.#otherRowids = reader.prepare(OTHER_ROWIDS_SQL);
  }

  /** Opens one search's hits over its ranking, which every rank and title, group or tag mark comes from. */
  openSearch(matchExpression: string, ranking: TextRanking): SearchHits {
    const markedEvents = new Map<number, string>();
    const readNarrowedEvents = (sessionIds: readonly SessionId[]): EventRow[] =>
      sessionIds.length === 0
        ? []
        : this.#narrowedEventRows.all({
            expression: narrowToSessions(matchExpression, sessionIds),
            open: MATCH_OPEN_MARK,
            close: MATCH_CLOSE_MARK,
          });
    const collect = (
      sessionIds: readonly SessionId[],
      eventRows: Iterable<EventRow>,
    ): Map<SessionId, SessionTextHits> => {
      const sessions = this.#otherRowids.all(JSON.stringify(sessionIds));
      const hitsBySession = new Map<SessionId, RankedHit[]>();
      for (const session of sessions) {
        const otherRowids: (number | null)[] = [
          session.title_index_rowid,
          session.group_index_rowid,
          ...(JSON.parse(session.tag_index_rowids) as number[]),
        ];
        const hits: RankedHit[] = [];
        for (const indexRowid of otherRowids) {
          const rank = indexRowid === null ? undefined : ranking.rankOf(indexRowid);
          if (indexRowid !== null && rank !== undefined) {
            hits.push({ rank, indexRowid, sessionId: session.session_id, sequence: undefined });
          }
        }
        hitsBySession.set(session.session_id, hits);
      }
      // A row of a session not asked about finds no list and is passed over.
      for (const row of eventRows) {
        const hits = hitsBySession.get(row.session_id);
        const rank = ranking.rankOf(row.index_rowid);
        if (hits === undefined || rank === undefined) {
          continue;
        }
        hits.push({
          rank,
          indexRowid: row.index_rowid,
          sessionId: row.session_id,
          sequence: row.sequence,
        });
        if (row.marked !== null) {
          markedEvents.set(row.index_rowid, row.marked);
        }
      }
      return new Map(
        sessions.map((session) => {
          const hits = (hitsBySession.get(session.session_id) ?? []).sort(compareRankedRows);
          return [session.session_id, { sessionId: session.session_id, name: session.name, hits }];
        }),
      );
    };
    return {
      readHits: (sessionIds) => collect(sessionIds, readNarrowedEvents(sessionIds)),
      readEveryHit: (sessionIds) =>
        collect(sessionIds, this.#eventRows.iterate(JSON.stringify(ranking.eventRowids()))),
      markHits: (hits) => {
        const unmarkedSessionIds = new Set<SessionId>();
        for (const hit of hits) {
          if (hit.sequence !== undefined && !markedEvents.has(hit.indexRowid)) {
            unmarkedSessionIds.add(hit.sessionId);
          }
        }
        for (const row of readNarrowedEvents([...unmarkedSessionIds])) {
          if (row.marked !== null) {
            markedEvents.set(row.index_rowid, row.marked);
          }
        }
        return hits.map((hit) =>
          markHit(
            hit,
            hit.sequence === undefined
              ? ranking.markedTextOf(hit.indexRowid)
              : markedEvents.get(hit.indexRowid),
          ),
        );
      },
    };
  }
}

// The match limited to the sessions' log rows, through each session's key.
function narrowToSessions(matchExpression: string, sessionIds: readonly SessionId[]): string {
  const keys = sessionIds.map((sessionId) => `"${sessionKeyOf(sessionId)}"`).join(" OR ");
  return `(${matchExpression}) AND session_key : (${keys})`;
}

// The hits and their marks come from one read transaction, so each row still matches; one that
// carries no match is a broken index and throws.
function markHit(hit: RankedHit, markedText: string | undefined): SessionSearchHit {
  const markedLine = readMarkedLine(markedText ?? "", TRANSCRIPT_SEARCH_TEXT_MAX_LEN);
  if (markedLine === undefined) {
    throw new Error(`The index row ${String(hit.indexRowid)} carries no match to mark.`);
  }
  const cursor =
    hit.sequence === undefined ? SESSION_START_CURSOR : encodeEventCursor(hit.sequence);
  return { cursor, ...markedLine };
}
