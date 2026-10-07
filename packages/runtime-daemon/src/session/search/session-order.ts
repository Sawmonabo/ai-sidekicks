// The order a search with words shows its sessions in. Words alone order sessions by their best
// row in the ranking: a session enters at its first row taken, and a group's row brings in every
// session in the group, in id order. Rows are taken only as far as a page reaches, and each
// session's place is kept once found, so every page of the search agrees on the order.

import type { Database, Statement } from "better-sqlite3";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { sourceRowidSql } from "./index-columns.js";
import type { TextRanking } from "./ranking.js";
import type { HeldRowCheck } from "./rowid-floors.js";
import type { SessionOrder } from "./snapshots.js";

const ROW_SESSION_SQL = `SELECT session_id FROM session_search_index WHERE rowid = ?`;

const GROUP_SESSIONS_SQL = `
  SELECT session.id AS session_id
    FROM session_groups AS session_group
    JOIN sessions AS session ON session.group_id = session_group.id
   WHERE session_group.rowid = ${sourceRowidSql("?", "group")}
   ORDER BY session.id`;

// What one placed session costs the order: its id in the list and in the set of those placed.
const BYTES_PER_SESSION = 2 * (36 * 2 + 32);

interface RowSession {
  /** `null` on a group's row, which belongs to every session in the group. */
  readonly session_id: SessionId | null;
}

/** Finds the sessions an index row belongs to. */
export class IndexRowSessions {
  readonly #rowSession: Statement<[number], RowSession>;
  readonly #groupSessions: Statement<[number], { readonly session_id: SessionId }>;

  constructor(reader: Database) {
    this.#rowSession = reader.prepare(ROW_SESSION_SQL);
    this.#groupSessions = reader.prepare(GROUP_SESSIONS_SQL);
  }

  /**
   * The row's session, or every session in a group's row's group; none for a row since removed,
   * whose session was purged or whose group was dissolved after the ranking was read.
   */
  sessionsOf(indexRowid: number): SessionId[] {
    const row = this.#rowSession.get(indexRowid);
    if (row === undefined) {
      return [];
    }
    return row.session_id === null
      ? this.#groupSessions.all(indexRowid).map((member) => member.session_id)
      : [row.session_id];
  }
}

/**
 * Sessions in the order of their best row in `ranking`, found as far as they are asked for. A row
 * taken after it stopped being the row the ranking read places no session, and never will.
 */
export function rankedSessionOrder(
  ranking: TextRanking,
  rowSessions: IndexRowSessions,
): SessionOrder {
  const sessionIds: SessionId[] = [];
  const placed = new Set<SessionId>();
  return {
    sessionAt(index, isHeldRow: HeldRowCheck) {
      while (sessionIds.length <= index) {
        const row = ranking.takeBestRow();
        if (row === undefined) {
          break;
        }
        if (!isHeldRow(row.indexRowid)) {
          continue;
        }
        for (const sessionId of rowSessions.sessionsOf(row.indexRowid)) {
          if (!placed.has(sessionId)) {
            placed.add(sessionId);
            sessionIds.push(sessionId);
          }
        }
      }
      return sessionIds[index];
    },
    get byteLength() {
      return sessionIds.length * BYTES_PER_SESSION;
    },
  };
}

/** A whole order already known, as a search by tag and words fuses it. */
export function listedSessionOrder(sessionIds: readonly SessionId[]): SessionOrder {
  return {
    sessionAt: (index) => sessionIds[index],
    byteLength: sessionIds.length * BYTES_PER_SESSION,
  };
}
