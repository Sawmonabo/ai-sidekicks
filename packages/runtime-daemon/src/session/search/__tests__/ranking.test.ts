// A ranking that reads every match with its session, from the index's session table, keeps the
// same rows of some sessions and their groups, with the same session and log position, as the
// narrowed read through their keys finds from the index's own columns.

import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { openDatabase } from "../../migration-runner.js";
import {
  insertEvent,
  insertGroup,
  insertSession,
  insertTag,
  sessionIdOf,
} from "../__fixtures__/index-rows.js";
import { indexRowidSql } from "../index/columns.js";
import {
  SessionTextRanking,
  WHOLE_INDEX,
  sessionsRankingOfRanges,
  type RankedIndexRow,
  type RankedSessionScope,
} from "../ranking.js";

const GROUP_ID = "00000000-0000-4000-9000-000000000001";

describe("the ranking within sessions", () => {
  let database: Database;

  beforeEach(() => {
    database = openDatabase(":memory:");
  });

  afterEach(() => {
    database.close();
  });

  it("owns the rows the narrowed read finds, read with every match's session", () => {
    insertGroup(database, GROUP_ID, "retry group");
    for (let index = 1; index <= 6; index += 1) {
      const sessionId = sessionIdOf(index);
      insertSession(database, sessionId, {
        name: `retry ${String(index)}`,
        ...(index % 2 === 0 ? { groupId: GROUP_ID } : {}),
      });
      insertTag(database, sessionId, index <= 3 ? "retry/kept" : "other");
      for (let sequence = 1; sequence <= 3; sequence += 1) {
        insertEvent(database, {
          sessionId,
          sequence,
          type: "user.message",
          message: `retry ${"word ".repeat(index + sequence)}`,
        });
      }
    }
    // Log rows of a session with no directory row, which no ranking within sessions owns.
    insertEvent(database, {
      sessionId: sessionIdOf(9),
      sequence: 1,
      type: "user.message",
      message: "retry",
    });
    const scopes = database
      .prepare<[string, string, string], RankedSessionScope>(
        `SELECT session.id AS sessionId, session.rowid AS sessionRowid, session.group_id AS groupId,
                CASE WHEN session.group_id IS NULL THEN NULL
                     ELSE ${indexRowidSql("session_group.rowid", "group")} END AS groupIndexRowid
           FROM sessions AS session
           LEFT JOIN session_groups AS session_group ON session_group.id = session.group_id
          WHERE session.id IN (?, ?, ?)`,
      )
      .all(sessionIdOf(1), sessionIdOf(2), sessionIdOf(3));
    const ranking = new SessionTextRanking(database);
    const matchExpression = 'text : ("retr"*)';

    const withSessions = sessionsRankingOfRanges(
      [ranking.rankRangeWithSessions(matchExpression, WHOLE_INDEX)],
      scopes,
    );
    const narrowed = ranking.rankWithinSessions(matchExpression, scopes);

    const owned = ownership(withSessions.rows);
    expect(owned).toEqual(ownership(narrowed.rows));
    // Three sessions' titles, tags and log rows, and their one group's row.
    expect(owned.filter((row) => row.session_id === null)).toHaveLength(1);
    expect(owned.filter((row) => row.sequence !== null)).toHaveLength(9);
    expect(new Set(owned.map((row) => row.session_id))).toEqual(
      new Set<SessionId | null>([null, ...[1, 2, 3].map(sessionIdOf)]),
    );
    expect(owned).toHaveLength(16);
  });
});

// The rows in rowid order, each with its session and position.
function ownership(rows: readonly RankedIndexRow[]): Omit<RankedIndexRow, "rank">[] {
  return rows
    .map(({ index_rowid, session_id, sequence }) => ({ index_rowid, session_id, sequence }))
    .sort((left, right) => left.index_rowid - right.index_rowid);
}
