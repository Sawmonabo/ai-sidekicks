// The index's ranking of a search's words. BM25 scores every matching row, so one read takes each
// row's rank, sorted here, and every later step of the page looks a rank up rather than asking the
// index to score again. Sessions come in the order of their best row: a session enters at its
// first row in the ranking, and a group's row brings in every session in the group, in id order.
// Only the rows walked before the page fills are traced to their sessions.

import type { Database, Statement } from "better-sqlite3";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { isEventRowSql, isEventRowid, sourceRowidSql } from "./index-columns.js";
import { MATCH_CLOSE_MARK, MATCH_OPEN_MARK } from "./marked-line.js";

// Rows come in rowid order, which the index gives without sorting and a rank lookup searches. A
// title, group or tag row is marked here, since those rows carry no session key a later read could
// narrow to; a log row is marked later, only for the sessions a page reads.
const RANKED_ROWS_SQL = `
  SELECT rowid AS index_rowid, rank,
         CASE WHEN NOT ${isEventRowSql("rowid")}
              THEN highlight(session_search_index, 0, @open, @close) END AS marked
    FROM session_search_index
   WHERE session_search_index MATCH @expression
   ORDER BY rowid`;

const ROW_SESSION_SQL = `SELECT session_id FROM session_search_index WHERE rowid = ?`;

const GROUP_SESSIONS_SQL = `
  SELECT session.id AS session_id
    FROM session_groups AS session_group
    JOIN sessions AS session ON session.group_id = session_group.id
   WHERE session_group.rowid = ${sourceRowidSql("?", "group")}
   ORDER BY session.id`;

interface RankedRow {
  readonly index_rowid: number;
  readonly rank: number;
  /** The marked text of a title, group or tag row; `null` on a log row. */
  readonly marked: string | null;
}

interface RowSession {
  /** `null` on a group's row, which belongs to every session in the group. */
  readonly session_id: SessionId | null;
}

/** A matching index row's place in the ranking: its BM25 rank, then its rowid. */
export interface RankedRowKey {
  readonly rank: number;
  readonly indexRowid: number;
}

/** A session at its best hit's place in the ranking. */
export interface RankedSessionKey extends RankedRowKey {
  readonly sessionId: SessionId;
}

/** Orders matching rows best first: by BM25 rank, then by rowid, so every page agrees on ties. */
export function compareRankedRows(left: RankedRowKey, right: RankedRowKey): number {
  return left.rank - right.rank || left.indexRowid - right.indexRowid;
}

/** Orders sessions by their best hit, then by id where one group's row ranks several. */
export function compareRankedSessions(left: RankedSessionKey, right: RankedSessionKey): number {
  const byRow = compareRankedRows(left, right);
  if (byRow !== 0) {
    return byRow;
  }
  return left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0;
}

/** One search's matching rows, each with its rank, best first. */
export interface TextRanking {
  /** The row's rank, `undefined` for a row the words do not match. */
  rankOf(indexRowid: number): number | undefined;
  /** A matching title, group or tag row's marked text, `undefined` for any other row. */
  markedTextOf(indexRowid: number): string | undefined;
  /** The rowids of every matching log row, in rowid order. */
  eventRowids(): number[];
  /**
   * Each session with a matching row, once, at its first row in the ranking at or after `from`.
   * A session met here may have a better row before `from`; the caller tells those apart. A
   * session the directory does not hold is yielded too and left to the caller.
   */
  sessionsFrom(from?: RankedSessionKey): Generator<RankedSessionKey>;
}

/** Reads the index's ranking of a search's words. */
export class SessionTextRanking {
  readonly #rankedRows: Statement<{ expression: string; open: string; close: string }, RankedRow>;
  readonly #rowSession: Statement<[number], RowSession>;
  readonly #groupSessions: Statement<[number], { readonly session_id: SessionId }>;

  constructor(reader: Database) {
    this.#rankedRows = reader.prepare(RANKED_ROWS_SQL);
    this.#rowSession = reader.prepare(ROW_SESSION_SQL);
    this.#groupSessions = reader.prepare(GROUP_SESSIONS_SQL);
  }

  /** Every row the match expression finds, ranked, in one read. */
  rank(matchExpression: string): TextRanking {
    const rows = this.#rankedRows.all({
      expression: matchExpression,
      open: MATCH_OPEN_MARK,
      close: MATCH_CLOSE_MARK,
    });
    // Positions in rowid order, sorted best first; a tie keeps rowid order.
    const order = Uint32Array.from(rows.keys()).sort(
      (left, right) => (rows[left]?.rank ?? 0) - (rows[right]?.rank ?? 0) || left - right,
    );
    const keyAt = (position: number): RankedRowKey => {
      const row = rows[order[position] ?? 0];
      return { rank: row?.rank ?? 0, indexRowid: row?.index_rowid ?? 0 };
    };
    const rowAt = (indexRowid: number): RankedRow | undefined => {
      const row =
        rows[
          firstPositionAtOrAfter(
            rows.length,
            (index) => (rows[index]?.index_rowid ?? 0) - indexRowid,
          )
        ];
      return row?.index_rowid === indexRowid ? row : undefined;
    };
    const rowSession = this.#rowSession;
    const groupSessions = this.#groupSessions;
    return {
      rankOf: (indexRowid) => rowAt(indexRowid)?.rank,
      markedTextOf: (indexRowid) => rowAt(indexRowid)?.marked ?? undefined,
      eventRowids: () =>
        rows.map((row) => row.index_rowid).filter((indexRowid) => isEventRowid(indexRowid)),
      *sessionsFrom(from) {
        const seen = new Set<SessionId>();
        const firstPosition =
          from === undefined
            ? 0
            : firstPositionAtOrAfter(order.length, (position) =>
                compareRankedRows(keyAt(position), from),
              );
        for (let position = firstPosition; position < order.length; position += 1) {
          const key = keyAt(position);
          const sessionId = rowSession.get(key.indexRowid)?.session_id ?? null;
          const sessionIds =
            sessionId === null
              ? groupSessions.all(key.indexRowid).map((member) => member.session_id)
              : [sessionId];
          for (const memberId of sessionIds) {
            const entry = { ...key, sessionId: memberId };
            if (
              seen.has(memberId) ||
              (from !== undefined && compareRankedSessions(entry, from) < 0)
            ) {
              continue;
            }
            seen.add(memberId);
            yield entry;
          }
        }
      },
    };
  }
}

// The first position whose comparison to the target is not below zero, in a sorted range.
function firstPositionAtOrAfter(length: number, compareAt: (position: number) => number): number {
  let low = 0;
  let high = length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareAt(middle) < 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}
