// `session.search` page by page: every hit is reachable exactly once, in the index's ranked order,
// each page inside the hit limit and one message, and a cursor continues only the search it came
// from.

import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jsonUtf8ByteLength } from "@ai-sidekicks/contracts/jsonrpc/message";
import {
  START_OF_LOG_POSITION,
  encodeEventCursor,
  type SessionId,
} from "@ai-sidekicks/contracts/session/id";
import {
  SESSION_SEARCH_CURSOR_UNRESOLVABLE_CODE,
  SessionSearchResponseSchema,
  type SessionSearchCursor,
  type SessionSearchGroup,
  type SessionSearchRequest,
} from "@ai-sidekicks/contracts/session/methods";
import { PAGE_MAX_BYTES } from "@ai-sidekicks/contracts/jsonrpc/page";

import { DaemonDomainError } from "../../../ipc/domain-error.js";
import { openDatabase } from "../../migration-runner.js";
import {
  insertEvent,
  insertGroup,
  insertSession,
  insertTag,
  sessionIdOf,
} from "../__fixtures__/index-rows.js";
import { SessionSearchService } from "../service.js";

// Every page of a search, each checked against its contract and the one-message budget, until the
// last.
function readEveryPage(
  sessionSearch: SessionSearchService,
  request: SessionSearchRequest,
): SessionSearchGroup[][] {
  const pages: SessionSearchGroup[][] = [];
  let afterCursor: SessionSearchCursor | undefined;
  // A search that never reaches its last page fails rather than running on.
  for (let pageCount = 0; pageCount < 100; pageCount += 1) {
    const page = SessionSearchResponseSchema.parse(
      sessionSearch.search(afterCursor === undefined ? request : { ...request, afterCursor }),
    );
    expect(jsonUtf8ByteLength(page.groups)).toBeLessThanOrEqual(PAGE_MAX_BYTES);
    pages.push(page.groups);
    if (!page.hasMore) {
      return pages;
    }
    afterCursor = page.nextCursor;
  }
  throw new Error("The search did not reach its last page in 100 pages.");
}

// Each hit of the pages in order, as its session, its cursor and its line.
function hitsOf(pages: readonly SessionSearchGroup[][]): string[] {
  return pages
    .flat()
    .flatMap((group) => group.hits.map((hit) => `${group.sessionId} ${hit.cursor} ${hit.line}`));
}

// Each hit of a search by words in the index's own ranked order, straight from the index: a
// session's hits together, in the order of its first row, a group's row counting for each member
// `groupMembers` names under the group's name.
function rankedHitsOf(
  database: Database,
  expression: string,
  groupMembers: ReadonlyMap<string, readonly SessionId[]>,
): string[] {
  const rankedRows = database
    .prepare(
      `SELECT session_id, sequence, text FROM session_search_index
        WHERE session_search_index MATCH ? ORDER BY rank, rowid`,
    )
    .all(expression) as { session_id: SessionId | null; sequence: number | null; text: string }[];
  const hitsBySession = new Map<SessionId, string[]>();
  for (const row of rankedRows) {
    const owners = row.session_id === null ? (groupMembers.get(row.text) ?? []) : [row.session_id];
    const cursor = encodeEventCursor(row.sequence ?? START_OF_LOG_POSITION);
    for (const sessionId of owners) {
      const hit = `${sessionId} ${cursor} ${row.text}`;
      hitsBySession.set(sessionId, [...(hitsBySession.get(sessionId) ?? []), hit]);
    }
  }
  return [...hitsBySession.values()].flat();
}

describe("session.search paging", () => {
  let database: Database;
  let sessionSearch: SessionSearchService;

  beforeEach(() => {
    database = openDatabase(":memory:");
    sessionSearch = new SessionSearchService(database);
  });

  afterEach(() => {
    database.close();
  });

  it("reaches every hit once, sessions by best hit and each session's hits together", () => {
    // The group's one-word name is the best hit of both its sessions, so a page boundary between
    // them falls on one index row.
    const groupId = insertGroup(database, "group-1", "retry");
    // Messages of different lengths rank apart; a short one ranks better.
    const messages: Record<number, string[]> = {
      1: ["retry once more", "the long retry of a request that waited on the queue for a while"],
      2: ["retry now please", "retry again"],
      3: ["a retry with some words around it"],
      4: Array.from({ length: 7 }, (_, index) => `retry attempt ${"x ".repeat(index)}`),
      5: ["one more retry message here today"],
    };
    for (const [index, texts] of Object.entries(messages)) {
      const sessionId = sessionIdOf(Number(index));
      insertSession(database, sessionId, Number(index) <= 2 ? { groupId } : {});
      texts.forEach((message, sequence) => {
        insertEvent(database, { sessionId, sequence, type: "user.message", message });
      });
    }
    insertSession(database, sessionIdOf(6), { name: "retry notes" });

    // Each session enters at its first row, and a group's row counts for every session in it.
    const rankedHits = rankedHitsOf(
      database,
      'text : ("retry")',
      new Map([["retry", [sessionIdOf(1), sessionIdOf(2)]]]),
    );
    expect(rankedHits).toHaveLength(16);

    const pages = readEveryPage(sessionSearch, { query: "retry", limit: 3 });
    expect(hitsOf(pages)).toEqual(rankedHits);
    // Only the session with more hits than a page holds spans pages, filling each it is on.
    const pagesOfSession = new Map<SessionId, number[]>();
    pages.forEach((groups, pageIndex) => {
      for (const group of groups) {
        pagesOfSession.set(group.sessionId, [
          ...(pagesOfSession.get(group.sessionId) ?? []),
          pageIndex,
        ]);
      }
    });
    for (const [sessionId, pageIndexes] of pagesOfSession) {
      expect(pageIndexes.length > 1).toBe(sessionId === sessionIdOf(4));
    }
    // Every page the split session is on before its last holds it alone, a page's worth of hits.
    const splitPageIndexes = pagesOfSession.get(sessionIdOf(4)) ?? [];
    for (const pageIndex of splitPageIndexes.slice(0, -1)) {
      expect(pages[pageIndex]?.map((group) => group.hits.length)).toEqual([3]);
    }
  });

  it("returns each hit the first page's search held once, however the index is written", () => {
    const groupId = insertGroup(database, "group-1", "retry");
    for (const index of [1, 2, 3, 4, 5, 6]) {
      const sessionId = sessionIdOf(index);
      insertSession(database, sessionId, index <= 2 ? { groupId } : {});
      // Lengths and repeats differ, so a move in the index's statistics can reorder rows.
      for (let sequence = 0; sequence < 3; sequence += 1) {
        const repeat = sequence === index % 3 ? "retry " : "";
        const message = `retry ${repeat}${"word ".repeat(index + sequence)}`;
        insertEvent(database, { sessionId, sequence, type: "user.message", message });
      }
    }
    insertSession(database, sessionIdOf(7));
    const heldHits = rankedHitsOf(
      database,
      'text : ("retry")',
      new Map([["retry", [sessionIdOf(1), sessionIdOf(2)]]]),
    );

    const hits: string[] = [];
    let page = sessionSearch.search({ query: "retry", limit: 2 });
    for (let pageCount = 1; ; pageCount += 1) {
      hits.push(...hitsOf([page.groups]));
      if (!page.hasMore) {
        break;
      }
      // Between pages: matching rows in sessions shown and still to come, a matching title and
      // tag, and unrelated rows that move every score.
      for (const index of [1, 6]) {
        insertEvent(database, {
          sessionId: sessionIdOf(index),
          sequence: 10 + pageCount,
          type: "user.message",
          message: "retry later",
        });
      }
      insertEvent(database, {
        sessionId: sessionIdOf(7),
        sequence: pageCount,
        type: "user.message",
        message: `unrelated ${"text ".repeat(pageCount * 7)}`,
      });
      database
        .prepare("UPDATE sessions SET name = ? WHERE id = ?")
        .run(`retry ${String(pageCount)}`, sessionIdOf(7));
      insertTag(database, sessionIdOf(3), `retry/${String(pageCount)}`);
      page = sessionSearch.search({ query: "retry", limit: 2, afterCursor: page.nextCursor });
    }

    expect(hits).toEqual(heldHits);
  });

  it("never shows a session purged between pages on a later page", () => {
    const shown = sessionIdOf(1);
    const purged = sessionIdOf(2);
    const kept = sessionIdOf(3);
    // Shorter text ranks better, so the sessions rank in this order.
    [shown, purged, kept].forEach((sessionId, index) => {
      insertSession(database, sessionId, { name: `retry ${"word ".repeat(index)}` });
      insertEvent(database, {
        sessionId,
        sequence: 0,
        type: "user.message",
        message: `retry ${"word ".repeat(index)}`,
      });
    });

    const firstPage = sessionSearch.search({ query: "retry", limit: 1 });
    if (!firstPage.hasMore) {
      throw new Error("The search pages.");
    }
    database.prepare("DELETE FROM session_events WHERE session_id = ?").run(purged);
    database.prepare("DELETE FROM sessions WHERE id = ?").run(purged);
    const laterPages = readEveryPage(sessionSearch, {
      query: "retry",
      limit: 1,
      afterCursor: firstPage.nextCursor,
    });

    // Each session's title and message are two hits, so a one-hit page splits each session.
    const sessionIds = [firstPage.groups, ...laterPages].flat().map((group) => group.sessionId);
    expect([...new Set(sessionIds)]).toEqual([shown, kept]);
  });

  it("credits a row at a purged row's rowid to no session and shows every held hit once", () => {
    const say = (sessionId: SessionId, sequence: number, message: string): void => {
      insertEvent(database, { sessionId, sequence, type: "user.message", message });
    };
    // A row of fewer tokens, its session's key among them, ranks better. The fillers rank first,
    // so the first page reads fillers alone; then the team, the purged session's messages, the
    // survivor ranked between, and last the survivor whose new rows take the purged rowids.
    const team = insertGroup(database, "group-team", "retry team one");
    for (const index of Array.from({ length: 70 }, (_, offset) => 100 + offset)) {
      insertSession(database, sessionIdOf(index));
      say(sessionIdOf(index), 0, "retry");
    }
    const [rewriter, member, between, purged, joined] = [1, 2, 3, 4, 5].map(sessionIdOf) as [
      SessionId,
      SessionId,
      SessionId,
      SessionId,
      SessionId,
    ];
    insertSession(database, rewriter);
    insertSession(database, member, { groupId: team });
    insertSession(database, between);
    say(rewriter, 0, "retry once more five");
    say(member, 0, "retry again now");
    say(between, 0, "retry tres four");
    // The purged session's rows are each table's newest, so rows written after its purge take
    // their rowids.
    const crew = insertGroup(database, "group-crew", "retry crew with many words");
    insertSession(database, purged, { name: "retry zed with many words here", groupId: crew });
    for (const sequence of [0, 1, 2]) {
      say(purged, sequence, "retry zed");
    }
    insertTag(database, purged, "retry/zed/old/crew/words");
    const heldHits = rankedHitsOf(
      database,
      'text : ("retry")',
      new Map([["retry team one", [member, joined]]]),
    ).filter((hit) => !hit.startsWith(purged));
    const rowidsOf = (sql: string, binding: string): number[] =>
      database.prepare(sql).pluck().all(binding) as number[];
    const eventRowidsOf = (sessionId: SessionId): number[] =>
      rowidsOf("SELECT rowid FROM session_events WHERE session_id = ? ORDER BY rowid", sessionId);
    const purgedRowids = {
      events: eventRowidsOf(purged),
      session: rowidsOf("SELECT rowid FROM sessions WHERE id = ?", purged),
      tag: rowidsOf("SELECT rowid FROM session_tags WHERE session_id = ?", purged),
      group: rowidsOf("SELECT rowid FROM session_groups WHERE id = ?", crew),
    };

    const firstPage = sessionSearch.search({ query: "retry", limit: 50 });
    if (!firstPage.hasMore) {
      throw new Error("The search pages.");
    }
    // Purged as the purge deletes, its emptied group with it.
    database.prepare("DELETE FROM session_events WHERE session_id = ?").run(purged);
    database.prepare("DELETE FROM session_tags WHERE session_id = ?").run(purged);
    database.prepare("DELETE FROM sessions WHERE id = ?").run(purged);
    database.prepare("DELETE FROM session_groups WHERE id = ?").run(crew);
    // A survivor's matching message, tag and group, and a new session in the team with a matching
    // title and messages, each at a rowid the purged rows held.
    say(rewriter, 1, "retry");
    insertSession(database, joined, { name: "retry", groupId: team });
    say(joined, 0, "retry");
    say(joined, 1, "nope");
    insertTag(database, rewriter, "retry");
    const other = insertGroup(database, "group-other", "retry");
    database.prepare("UPDATE sessions SET group_id = ? WHERE id = ?").run(other, rewriter);
    expect({
      events: [...eventRowidsOf(rewriter).slice(1), ...eventRowidsOf(joined)],
      session: rowidsOf("SELECT rowid FROM sessions WHERE id = ?", joined),
      tag: rowidsOf("SELECT rowid FROM session_tags WHERE session_id = ?", rewriter),
      group: rowidsOf("SELECT rowid FROM session_groups WHERE id = ?", other),
    }).toEqual(purgedRowids);

    const laterPages = readEveryPage(sessionSearch, {
      query: "retry",
      limit: 50,
      afterCursor: firstPage.nextCursor,
    });
    // The new session shows only the team's row it now shares, and the rewriter keeps its place.
    expect(hitsOf([firstPage.groups, ...laterPages])).toEqual(heldHits);
  });

  it("lets a held search go over budget, when idle or past the floor log, refusing it", () => {
    vi.useFakeTimers();
    try {
      const idleMs = 60_000;
      const boundedSearch = new SessionSearchService(database, { maxBytes: 1, idleMs });
      for (const index of [1, 2]) {
        const sessionId = sessionIdOf(index);
        insertSession(database, sessionId);
        insertEvent(database, {
          sessionId,
          sequence: 0,
          type: "user.message",
          message: "retry again",
        });
      }
      const refusalOf = (request: SessionSearchRequest): unknown => {
        try {
          boundedSearch.search(request);
        } catch (error) {
          return error instanceof DaemonDomainError ? error.code : error;
        }
        return "answered";
      };
      const first = boundedSearch.search({ query: "retry", limit: 1 });
      const second = boundedSearch.search({ query: "again", limit: 1 });
      if (!first.hasMore || !second.hasMore) {
        throw new Error("Both searches page.");
      }

      // Holding the second search put the two over budget, so the first was let go.
      expect(refusalOf({ query: "retry", afterCursor: first.nextCursor })).toBe(
        SESSION_SEARCH_CURSOR_UNRESOLVABLE_CODE,
      );
      expect(refusalOf({ query: "again", afterCursor: second.nextCursor })).toBe("answered");
      vi.advanceTimersByTime(idleMs);
      expect(refusalOf({ query: "again", afterCursor: second.nextCursor })).toBe(
        SESSION_SEARCH_CURSOR_UNRESOLVABLE_CODE,
      );
      // Each newest tag deleted lowers the tags' highest rowid; past what the floor log keeps, the
      // rows later rows took can no longer be told.
      const third = boundedSearch.search({ query: "retry", limit: 1 });
      if (!third.hasMore) {
        throw new Error("The search pages.");
      }
      const removeNewestTag = database.prepare(
        "DELETE FROM session_tags WHERE rowid = (SELECT max(rowid) FROM session_tags)",
      );
      for (let count = 0; count <= 4096; count += 1) {
        insertTag(database, sessionIdOf(1), "churn");
        removeNewestTag.run();
      }
      expect(refusalOf({ query: "retry", afterCursor: third.nextCursor })).toBe(
        SESSION_SEARCH_CURSOR_UNRESOLVABLE_CODE,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps every page inside one message, whole sessions first and one too large split", () => {
    // Every message is one long line, so a page of them overflows a message before the hit limit.
    const insertLongLines = (
      sessionId: SessionId,
      sequences: readonly number[],
      paddingCount: number,
    ): void => {
      const message = `retry ${"padding ".repeat(paddingCount)}`;
      for (const sequence of sequences) {
        insertEvent(database, { sessionId, sequence, type: "user.message", message });
      }
    };
    const sequencesFrom = (first: number, count: number): number[] =>
      Array.from({ length: count }, (_, index) => first + index);
    // The large session's shorter lines rank first. At this line length its own members, a long
    // name among them, are what push its leading hits past one message.
    const large = sessionIdOf(5);
    insertSession(database, large, { name: "n".repeat(256) });
    insertLongLines(large, sequencesFrom(1000, 300), 489);
    for (const index of [1, 2, 3, 4]) {
      insertSession(database, sessionIdOf(index));
      insertLongLines(sessionIdOf(index), sequencesFrom(0, 50), 500);
    }

    const pages = readEveryPage(sessionSearch, { query: "retry" });
    const hits = hitsOf(pages);
    expect(hits).toHaveLength(300 + 4 * 50);
    expect(new Set(hits).size).toBe(hits.length);
    // The large session alone overflows a message and goes on into the next, where whole sessions
    // follow until the next one would overflow it.
    expect(pages.map((groups) => groups.map((group) => group.sessionId))).toEqual([
      [large],
      [large, sessionIdOf(1), sessionIdOf(2), sessionIdOf(3)],
      [sessionIdOf(4)],
    ]);
  });

  it("pages a search by tag, alone or with words, along the order of its whole answer", () => {
    for (const index of [1, 2, 3, 4]) {
      const sessionId = sessionIdOf(index);
      insertSession(database, sessionId, {
        lastActivityAt: `2026-10-0${String(5 - index)}T00:00:00.000Z`,
      });
      insertEvent(database, {
        sessionId,
        sequence: 0,
        type: "user.message",
        message: `auth ${"word ".repeat(index)}`,
      });
      insertEvent(database, {
        sessionId,
        sequence: 1,
        type: "user.message",
        message: "auth again",
      });
      insertTag(database, sessionId, "billing");
    }
    // A session with more matching tags than a page holds goes on across pages.
    insertTag(database, sessionIdOf(2), "billing/stripe");
    insertTag(database, sessionIdOf(2), "billing/refunds");

    for (const query of ["tag:billing", "tag:billing auth"]) {
      const whole = SessionSearchResponseSchema.parse(sessionSearch.search({ query }));
      expect(hitsOf([whole.groups])).toHaveLength(query === "tag:billing" ? 6 : 8);
      expect(hitsOf(readEveryPage(sessionSearch, { query, limit: 1 }))).toEqual(
        hitsOf([whole.groups]),
      );
    }
  });

  it("refuses a cursor that does not continue the search it is sent with", () => {
    for (const index of [1, 2]) {
      const sessionId = sessionIdOf(index);
      insertSession(database, sessionId);
      insertEvent(database, { sessionId, sequence: 0, type: "user.message", message: "retry" });
      insertTag(database, sessionId, "billing");
    }
    const wordsPage = sessionSearch.search({ query: "retry", limit: 1 });
    const tagPage = sessionSearch.search({ query: "tag:billing", limit: 1 });
    if (!wordsPage.hasMore || !tagPage.hasMore) {
      throw new Error("Both searches page.");
    }

    const refusalOf = (request: SessionSearchRequest): unknown => {
      try {
        sessionSearch.search(request);
      } catch (error) {
        return error instanceof DaemonDomainError ? error.code : error;
      }
      return "answered";
    };
    expect(refusalOf({ query: "tag:billing", afterCursor: wordsPage.nextCursor })).toBe(
      SESSION_SEARCH_CURSOR_UNRESOLVABLE_CODE,
    );
    expect(refusalOf({ query: "retry", afterCursor: tagPage.nextCursor })).toBe(
      SESSION_SEARCH_CURSOR_UNRESOLVABLE_CODE,
    );
    expect(
      refusalOf({
        query: "retry",
        afterCursor: `r:${sessionIdOf(1)}:x` as SessionSearchCursor,
      }),
    ).toBe(SESSION_SEARCH_CURSOR_UNRESOLVABLE_CODE);
    expect(refusalOf({ query: "retry", afterCursor: wordsPage.nextCursor })).toBe("answered");
  });
});
