// The match count against `highlight()`: per row it counts the stretches `highlight()` marks,
// overlapping matches as one, for phrases of several words and for prefixes; and loading it leaves
// SQL's `load_extension()` refused on each of the daemon's connections.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../migration-runner.js";
import { insertEvent, insertSession, sessionIdOf } from "../__fixtures__/index-rows.js";
import { isEventRowSql, ownerKeySql } from "../index/columns.js";
import { MATCH_COUNT_LIBRARY_PATH, loadMatchCount } from "../match-count.js";
import { MATCH_OPEN_MARK } from "../marked-line.js";
import { matchExpressionOf } from "../query.js";

interface CountedRow {
  readonly counted: number;
  readonly marked: string;
}

describe("the match count", () => {
  let database: DatabaseType;
  const sessionId = sessionIdOf(1);

  beforeEach(() => {
    database = openDatabase(":memory:");
    loadMatchCount(database);
    insertSession(database, sessionId);
    const contents = [
      "alpha beta gamma",
      "alpha alpha alpha",
      "beta gamma beta gamma",
      "retry retried retrying",
      "alpha beta alpha",
    ];
    contents.forEach((content, index) => {
      insertEvent(database, { sessionId, sequence: index + 1, type: "assistant.message", content });
    });
  });

  afterEach(() => {
    database.close();
  });

  // Each matching log row's count beside the stretches `highlight()` marks in it, in log order.
  function countsBesideHighlights(expression: string): { counted: number; marked: number }[] {
    return database
      .prepare<{ expression: string; open: string }, CountedRow>(
        `SELECT match_count(session_search_index, 0) AS counted,
                highlight(session_search_index, 0, @open, '') AS marked
           FROM session_search_index
          WHERE session_search_index MATCH @expression AND ${isEventRowSql("rowid")}
          ORDER BY rowid`,
      )
      .all({ expression, open: MATCH_OPEN_MARK })
      .map((row) => ({
        counted: row.counted,
        marked: row.marked.split(MATCH_OPEN_MARK).length - 1,
      }));
  }

  it("counts per row the stretches highlight() marks, overlapping matches as one", () => {
    const ownerKey = database.prepare<[string], string>(`SELECT ${ownerKeySql("?")}`).pluck();
    const sessionMatch = (expression: string): string =>
      `${expression} AND owner_key : "${String(ownerKey.get(sessionId))}"`;
    const cases: readonly (readonly [string, readonly number[]])[] = [
      // Two phrases sharing a word are one stretch; apart they are two.
      [`text : ("alpha beta" OR "beta gamma")`, [1, 2, 1]],
      // A phrase overlapping itself.
      [`text : "alpha alpha"`, [1]],
      [`text : "beta gamma"`, [1, 2]],
      [`text : "alpha"`, [1, 3, 2]],
      // A prefix, and a word that matches inside it as well.
      [`text : "retr"*`, [3]],
      [`text : ("retry" OR "retr"*)`, [3]],
      // A find box's own query, which also matches the session's key in the other column.
      [sessionMatch(matchExpressionOf("alp") ?? ""), [1, 3, 2]],
      [sessionMatch(matchExpressionOf("beta gam") ?? ""), [2, 4]],
    ];
    for (const [expression, counts] of cases) {
      expect(countsBesideHighlights(expression), expression).toEqual(
        counts.map((count) => ({ counted: count, marked: count })),
      );
    }
  });

  it("keeps SQL's load_extension() refused on every daemon connection", async () => {
    const folder = await mkdtemp(join(tmpdir(), "match-count-"));
    const databasePath = join(folder, "daemon.db");
    // The writer's connection, the main thread's reader, and the search thread's, which loads it.
    const writer = openDatabase(databasePath);
    const reader = new Database(databasePath, { readonly: true, fileMustExist: true });
    const searchReader = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      loadMatchCount(searchReader);
      for (const connection of [writer, reader, searchReader]) {
        expect(() =>
          connection.prepare("SELECT load_extension(?)").get(MATCH_COUNT_LIBRARY_PATH),
        ).toThrow("not authorized");
      }
    } finally {
      searchReader.close();
      reader.close();
      writer.close();
      await rm(folder, { recursive: true, force: true });
    }
  });
});
