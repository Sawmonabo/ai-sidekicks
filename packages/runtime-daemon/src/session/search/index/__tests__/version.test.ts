// The full-text index's version moves with every write of an index row, of every kind, and stays
// put through the idle merges, which change how the index is stored but not what it holds.

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
import { SearchIndexVersion } from "../version.js";

describe("the search index's version", () => {
  let database: Database;
  let indexVersion: SearchIndexVersion;
  const sessionId = sessionIdOf(1);
  const groupId = "00000000-0000-4000-9000-000000000001";

  beforeEach(() => {
    database = openDatabase(":memory:");
    indexVersion = new SearchIndexVersion(database);
  });

  afterEach(() => {
    database.close();
  });

  it("moves with each write of a log, title, group or tag row, and not with a merge", () => {
    const writes: readonly (readonly [string, () => void])[] = [
      ["title insert", () => insertSession(database, sessionId, { name: "retry work" })],
      [
        "title rename",
        () => run("UPDATE sessions SET name = 'retry plan' WHERE id = ?", sessionId),
      ],
      [
        "log row insert",
        () =>
          insertEvent(database, {
            sessionId,
            sequence: 1,
            type: "assistant.message",
            content: "retry",
          }),
      ],
      ["log row delete", () => run("DELETE FROM session_events WHERE session_id = ?", sessionId)],
      ["group insert", () => insertGroup(database, groupId, "billing")],
      [
        "group rename",
        () => run("UPDATE session_groups SET name = 'payments' WHERE id = ?", groupId),
      ],
      ["group delete", () => run("DELETE FROM session_groups WHERE id = ?", groupId)],
      ["tag insert", () => insertTag(database, sessionId, "billing")],
      [
        "tag rename",
        () => run("UPDATE session_tags SET tag = 'Billing' WHERE session_id = ?", sessionId),
      ],
      ["tag delete", () => run("DELETE FROM session_tags WHERE session_id = ?", sessionId)],
      ["title delete", () => run("DELETE FROM sessions WHERE id = ?", sessionId)],
    ];
    for (const [label, write] of writes) {
      const before = indexVersion.read();
      write();
      expect(indexVersion.read(), label).toBeGreaterThan(before);
    }

    const merged = indexVersion.read();
    run("INSERT INTO session_search_index (session_search_index, rank) VALUES ('merge', 500)");
    run("INSERT INTO session_search_index (session_search_index, rank) VALUES ('merge', -500)");
    run("INSERT INTO session_search_index (session_search_index) VALUES ('optimize')");
    expect(indexVersion.read()).toBe(merged);
  });

  function run(sql: string, ...parameters: string[]): void {
    database.prepare(sql).run(...parameters);
  }
});
