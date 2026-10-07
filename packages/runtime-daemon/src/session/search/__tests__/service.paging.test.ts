// `session.search` page by page: every hit is reachable exactly once, in the index's ranked order,
// each page inside the hit limit and one message, and a cursor continues only the search it came
// from.

import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

  it("reaches every hit exactly once, sessions by best hit and each session's hits together", () => {
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

    // The ranking straight from the index: each session enters at its first row, and a group's
    // row counts for every session in the group.
    const rankedRows = database
      .prepare(
        `SELECT session_id, sequence, text FROM session_search_index
          WHERE session_search_index MATCH 'text : ("retry")' ORDER BY rank, rowid`,
      )
      .all() as { session_id: SessionId | null; sequence: number | null; text: string }[];
    const hitsBySession = new Map<SessionId, string[]>();
    for (const row of rankedRows) {
      const owners = row.session_id === null ? [sessionIdOf(1), sessionIdOf(2)] : [row.session_id];
      const cursor = encodeEventCursor(row.sequence ?? START_OF_LOG_POSITION);
      for (const sessionId of owners) {
        const hit = `${sessionId} ${cursor} ${row.text}`;
        hitsBySession.set(sessionId, [...(hitsBySession.get(sessionId) ?? []), hit]);
      }
    }
    const rankedHits = [...hitsBySession.values()].flat();
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
        afterCursor: `r:01:4:${sessionIdOf(1)}:0` as SessionSearchCursor,
      }),
    ).toBe(SESSION_SEARCH_CURSOR_UNRESOLVABLE_CODE);
    expect(refusalOf({ query: "retry", afterCursor: wordsPage.nextCursor })).toBe("answered");
  });
});
