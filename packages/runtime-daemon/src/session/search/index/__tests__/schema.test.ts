// The index's session table holds, after every write of every kind, the session and log position
// of exactly the log, title and tag rows the index holds, so a ranking that reads each match's
// session from it reads what the index's own columns say.

import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../../migration-runner.js";
import {
  insertEvent,
  insertGroup,
  insertSession,
  insertTag,
  sessionIdOf,
} from "../../__fixtures__/index-rows.js";

interface RowSession {
  readonly index_rowid: number;
  readonly session_rowid: number;
  readonly sequence: number | null;
}

describe("the search index's session table", () => {
  let database: Database;
  const named = sessionIdOf(1);
  const unnamed = sessionIdOf(2);
  // A session with log rows and no directory row, as the daemon's own sentinel session has.
  const withoutRow = sessionIdOf(3);
  const groupId = "00000000-0000-4000-9000-000000000001";

  beforeEach(() => {
    database = openDatabase(":memory:");
  });

  afterEach(() => {
    database.close();
  });

  it("follows every write of a log, title, group or tag row", () => {
    const writes: readonly (readonly [string, () => void])[] = [
      ["group insert", () => insertGroup(database, groupId, "billing")],
      ["title insert", () => insertSession(database, named, { name: "retry", groupId })],
      ["untitled insert", () => insertSession(database, unnamed)],
      [
        "title on an untitled session",
        () => run("UPDATE sessions SET name = 'b' WHERE id = ?", unnamed),
      ],
      [
        "log rows",
        () => {
          insertEvent(database, {
            sessionId: named,
            sequence: 1,
            type: "user.message",
            message: "a",
          });
          insertEvent(database, { sessionId: named, sequence: 2, type: "user.message" });
          insertEvent(database, {
            sessionId: unnamed,
            sequence: 1,
            type: "tool.invoked",
            toolName: "t",
          });
          insertEvent(database, {
            sessionId: withoutRow,
            sequence: 1,
            type: "user.message",
            message: "c",
          });
        },
      ],
      [
        "tag insert",
        () => {
          insertTag(database, named, "billing");
          insertTag(database, unnamed, "billing/api");
        },
      ],
      [
        "tag rename",
        () => run("UPDATE session_tags SET tag = 'Billing' WHERE session_id = ?", named),
      ],
      [
        "group rename",
        () => run("UPDATE session_groups SET name = 'payments' WHERE id = ?", groupId),
      ],
      ["title rename", () => run("UPDATE sessions SET name = 'plan' WHERE id = ?", named)],
      ["title removed", () => run("UPDATE sessions SET name = NULL WHERE id = ?", unnamed)],
      [
        "log row delete",
        () => run("DELETE FROM session_events WHERE session_id = ? AND sequence = 1", named),
      ],
      ["tag delete", () => run("DELETE FROM session_tags WHERE session_id = ?", named)],
      [
        "purge",
        () => {
          run("DELETE FROM session_events WHERE session_id = ?", unnamed);
          run("DELETE FROM session_tags WHERE session_id = ?", unnamed);
          run("DELETE FROM sessions WHERE id = ?", unnamed);
        },
      ],
      [
        "group delete",
        () => {
          run("UPDATE sessions SET group_id = NULL WHERE id = ?", named);
          run("DELETE FROM session_groups WHERE id = ?", groupId);
        },
      ],
      [
        "purge of a titled session",
        () => {
          run("DELETE FROM session_events WHERE session_id = ?", named);
          run("DELETE FROM sessions WHERE id = ?", named);
        },
      ],
    ];
    const heldCounts: number[] = [];
    for (const [label, write] of writes) {
      write();
      const indexed = indexedRowSessions();
      expect(sessionTable(), label).toEqual(indexed);
      heldCounts.push(indexed.length);
    }
    // The table was compared while it held rows of every kind, not only while empty.
    expect(heldCounts).toEqual([0, 1, 1, 2, 4, 6, 6, 6, 6, 5, 4, 3, 1, 1, 0]);
  });

  // Each log, title and tag row the index holds, with its session's directory rowid and position.
  function indexedRowSessions(): RowSession[] {
    return database
      .prepare<[], RowSession>(
        `SELECT indexed.rowid AS index_rowid, session.rowid AS session_rowid, indexed.sequence
           FROM session_search_index AS indexed
           JOIN sessions AS session ON session.id = indexed.session_id
          ORDER BY indexed.rowid`,
      )
      .all();
  }

  function sessionTable(): RowSession[] {
    return database
      .prepare<[], RowSession>(
        `SELECT index_rowid, session_rowid, sequence
           FROM session_search_index_sessions ORDER BY index_rowid`,
      )
      .all();
  }

  function run(sql: string, ...parameters: string[]): void {
    database.prepare(sql).run(...parameters);
  }
});
