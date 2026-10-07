// `session.search` over the schema's own full-text index: what its triggers index, what a query
// finds, and the cursor and marked stretch each hit carries.

import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encodeEventCursor, START_OF_LOG_POSITION } from "@ai-sidekicks/contracts/session/id";

import { openDatabase } from "../../migration-runner.js";
import {
  insertEvent,
  insertGroup,
  insertSession,
  insertTag,
  sessionIdOf,
} from "../__fixtures__/index-rows.js";
import { SessionSearchService } from "../service.js";

const SESSION_START = encodeEventCursor(START_OF_LOG_POSITION);

describe("session.search", () => {
  let database: Database;
  let sessionSearch: SessionSearchService;

  beforeEach(() => {
    database = openDatabase(":memory:");
    sessionSearch = new SessionSearchService(database);
  });

  afterEach(() => {
    database.close();
  });

  it("finds a settled message, never a thinking update, and nothing once the row is purged", () => {
    const settled = sessionIdOf(1);
    const narrating = sessionIdOf(2);
    insertSession(database, settled, { name: "release" });
    insertSession(database, narrating);
    insertEvent(database, {
      sessionId: settled,
      sequence: 3,
      type: "user.message",
      message: "first line\nplease deploy the worker",
    });
    insertEvent(database, {
      sessionId: narrating,
      sequence: 1,
      type: "assistant.thinking_update",
      content: "deploy the worker",
    });

    // The last word matches as a prefix while it is typed.
    expect(sessionSearch.search({ query: "depl" })).toEqual({
      groups: [
        {
          sessionId: settled,
          name: "release",
          hits: [
            {
              cursor: encodeEventCursor(3),
              line: "please deploy the worker",
              matchRanges: [{ start: 7, end: 13 }],
            },
          ],
        },
      ],
      hasMore: false,
    });

    database.prepare("DELETE FROM session_events WHERE session_id = ?").run(settled);
    expect(sessionSearch.search({ query: "deploy" })).toEqual({ groups: [], hasMore: false });
  });

  it("finds an assistant's message and a tool call by its name and arguments", () => {
    const sessionId = sessionIdOf(1);
    insertSession(database, sessionId);
    insertEvent(database, {
      sessionId,
      sequence: 1,
      type: "assistant.message",
      content: "The webhook retries now.",
    });
    insertEvent(database, {
      sessionId,
      sequence: 2,
      type: "tool.invoked",
      toolName: "Bash",
      content: '{"command":"stripe listen"}',
    });

    const [group] = sessionSearch.search({ query: "webhook" }).groups;
    expect(group?.hits.map((hit) => hit.cursor)).toEqual([encodeEventCursor(1)]);
    const [toolGroup] = sessionSearch.search({ query: "bash stripe" }).groups;
    expect(toolGroup?.hits).toEqual([
      {
        cursor: encodeEventCursor(2),
        line: 'Bash {"command":"stripe listen"}',
        matchRanges: [
          { start: 0, end: 4 },
          { start: 17, end: 23 },
        ],
      },
    ]);
  });

  it("finds a renamed session by its new title and no longer by its old one", () => {
    const sessionId = sessionIdOf(1);
    insertSession(database, sessionId, { name: "scratch notes" });
    database.prepare("UPDATE sessions SET name = 'billing migration' WHERE id = ?").run(sessionId);

    expect(sessionSearch.search({ query: "scratch" })).toEqual({ groups: [], hasMore: false });
    expect(sessionSearch.search({ query: "migration" })).toEqual({
      groups: [
        {
          sessionId,
          name: "billing migration",
          hits: [
            {
              cursor: SESSION_START,
              line: "billing migration",
              matchRanges: [{ start: 8, end: 17 }],
            },
          ],
        },
      ],
      hasMore: false,
    });
  });

  it("finds every session in a group by the group's name, and a session by its tag's words", () => {
    const groupId = insertGroup(database, "group-1", "auth work");
    insertSession(database, sessionIdOf(1), { groupId });
    insertSession(database, sessionIdOf(2), { groupId });
    insertSession(database, sessionIdOf(3));
    insertSession(database, sessionIdOf(4));
    insertTag(database, sessionIdOf(4), "auth");

    const groups = sessionSearch.search({ query: "auth" }).groups;
    // The one-word tag ranks above the two-word group name.
    expect(groups.map((group) => group.sessionId)).toEqual([
      sessionIdOf(4),
      sessionIdOf(1),
      sessionIdOf(2),
    ]);
    expect(groups.map((group) => group.hits)).toEqual([
      [{ cursor: SESSION_START, line: "auth", matchRanges: [{ start: 0, end: 4 }] }],
      [{ cursor: SESSION_START, line: "auth work", matchRanges: [{ start: 0, end: 4 }] }],
      [{ cursor: SESSION_START, line: "auth work", matchRanges: [{ start: 0, end: 4 }] }],
    ]);
  });

  it("finds a tag and the tags nested under it, ignoring case, and never a longer tag", () => {
    const parent = sessionIdOf(1);
    const nested = sessionIdOf(2);
    const longer = sessionIdOf(3);
    insertSession(database, parent, { lastActivityAt: "2026-10-01T00:00:00.000Z" });
    insertSession(database, nested, { lastActivityAt: "2026-10-05T00:00:00.000Z" });
    insertSession(database, longer);
    insertTag(database, parent, "billing");
    insertTag(database, nested, "Billing/Stripe");
    insertTag(database, longer, "billingx");

    expect(sessionSearch.search({ query: "tag:BILLING" })).toEqual({
      groups: [
        {
          sessionId: nested,
          hits: [
            { cursor: SESSION_START, line: "Billing/Stripe", matchRanges: [{ start: 0, end: 7 }] },
          ],
        },
        {
          sessionId: parent,
          hits: [{ cursor: SESSION_START, line: "billing", matchRanges: [{ start: 0, end: 7 }] }],
        },
      ],
      hasMore: false,
    });
  });

  it("keeps the tagged sessions the words find, ordered by their text and tag ranks fused", () => {
    // Shorter text ranks better; the tag ranks the most recently active first. Each order differs.
    const sessions = [
      { index: 1, message: "auth", lastActivityAt: "2026-10-02T00:00:00.000Z" },
      { index: 2, message: "auth x y", lastActivityAt: "2026-10-01T00:00:00.000Z" },
      { index: 3, message: "auth x y z w v", lastActivityAt: "2026-10-03T00:00:00.000Z" },
      { index: 4, message: "auth", lastActivityAt: "2026-10-04T00:00:00.000Z" },
    ];
    for (const { index, message, lastActivityAt } of sessions) {
      insertSession(database, sessionIdOf(index), { lastActivityAt });
      insertEvent(database, {
        sessionId: sessionIdOf(index),
        sequence: 1,
        type: "user.message",
        message,
      });
    }
    for (const index of [1, 2, 3]) {
      insertTag(database, sessionIdOf(index), "billing/stripe");
    }

    // Text rank 1, 3, 4 (the untagged session holds 2) and tag rank 2, 3, 1 fuse to 1, 3, 2.
    const groups = sessionSearch.search({ query: "tag:billing auth" }).groups;
    expect(groups.map((group) => group.sessionId)).toEqual([
      sessionIdOf(1),
      sessionIdOf(3),
      sessionIdOf(2),
    ]);
    expect(groups[1]?.hits.map((hit) => hit.line)).toEqual(["auth x y z w v"]);
  });

  it("reads a row holding the characters matches are marked with as text, never as marks", () => {
    const sessionId = sessionIdOf(1);
    insertSession(database, sessionId);
    // A lone opening mark, then a closing one before an opening one, as pasted text may carry.
    insertEvent(database, {
      sessionId,
      sequence: 1,
      type: "user.message",
      message: "say \uFDD0 deploy\uFDD1\uFDD0 now",
    });

    expect(sessionSearch.search({ query: "deploy" }).groups).toEqual([
      {
        sessionId,
        hits: [
          {
            cursor: encodeEventCursor(1),
            line: "say   deploy   now",
            matchRanges: [{ start: 6, end: 12 }],
          },
        ],
      },
    ]);
  });

  it("keeps typed operators as text, so a query never breaks the index's syntax", () => {
    const sessionId = sessionIdOf(1);
    insertSession(database, sessionId);
    insertEvent(database, { sessionId, sequence: 1, type: "user.message", message: "NOT done" });

    expect(sessionSearch.search({ query: 'NOT "done' }).groups).toHaveLength(1);
    expect(sessionSearch.search({ query: "-- * :" })).toEqual({ groups: [], hasMore: false });
  });
});
