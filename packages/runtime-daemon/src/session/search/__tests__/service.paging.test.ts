// `session.search` page by page: a later page reads the view of the index its first page held, so
// writes between pages neither repeat nor drop a hit; a hit whose row is gone is passed over, one
// whose text changed is marked on its text now, and one whose rowid a later row took counts for no
// session, and a full page reads on past sessions left with no hit to tell where the next starts.
// A search let go refuses its cursor, as does a cursor of another search, and every page fits one
// message.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { jsonUtf8ByteLength } from "@ai-sidekicks/contracts/jsonrpc/byte-length";
import { PAGE_MAX_BYTES } from "@ai-sidekicks/contracts/jsonrpc/page";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import {
  SessionSearchResponseSchema,
  type SessionSearchCursor,
  type SessionSearchGroup,
  type SessionSearchRequest,
} from "@ai-sidekicks/contracts/session/methods";
import { SESSION_SEARCH_CURSOR_UNRESOLVABLE_CODE } from "@ai-sidekicks/contracts/session/search";

import { DaemonDomainError } from "../../../ipc/domain-error.js";
import {
  insertEvent,
  insertSession,
  insertTag,
  purgeSession,
  sessionIdOf,
} from "../__fixtures__/index-rows.js";
import { readEveryHit, type ShownHit } from "../__fixtures__/reference-ranking.js";
import { SearchFixture } from "../__fixtures__/services.js";
import { DEFAULT_SEARCH_SNAPSHOT_LIMITS } from "../snapshots.js";

// Every page of a search from `request` on, each checked against its contract and the
// one-message budget, until the last.
function readPagesFrom(
  search: (request: SessionSearchRequest) => unknown,
  request: SessionSearchRequest,
): SessionSearchGroup[][] {
  const pages: SessionSearchGroup[][] = [];
  let next: SessionSearchRequest | undefined = request;
  while (next !== undefined) {
    const page = SessionSearchResponseSchema.parse(search(next));
    expect(jsonUtf8ByteLength(page.groups)).toBeLessThanOrEqual(PAGE_MAX_BYTES);
    pages.push(page.groups);
    next = page.hasMore ? { ...request, afterCursor: page.nextCursor } : undefined;
  }
  return pages;
}

function shownHitsOf(pages: readonly SessionSearchGroup[][]): ShownHit[] {
  return pages
    .flat()
    .flatMap((group) =>
      group.hits.map((hit) => ({ sessionId: group.sessionId, cursor: hit.cursor, line: hit.line })),
    );
}

describe("session.search paging", () => {
  let fixture: SearchFixture;

  beforeEach(async () => {
    fixture = await SearchFixture.open();
  });

  afterEach(async () => {
    await fixture.close();
  });

  it("holds its view across writes between pages, passing over rows gone or taken since", async () => {
    const { database } = fixture;
    // Rows no query here finds, so the searched word is rare enough to score above zero.
    insertSession(database, sessionIdOf(9));
    for (let sequence = 0; sequence < 12; sequence += 1) {
      insertEvent(database, {
        sessionId: sessionIdOf(9),
        sequence,
        type: "user.message",
        message: "unrelated words",
      });
    }
    // Each session's message is longer than the last, so it ranks below it, and the third
    // session's title ranks between the second's message and its own.
    for (const index of [1, 2, 3, 4, 5, 6]) {
      insertSession(
        database,
        sessionIdOf(index),
        index === 3 ? { name: "deploy plan doc notes for review" } : {},
      );
      insertEvent(database, {
        sessionId: sessionIdOf(index),
        sequence: 0,
        type: "user.message",
        message: `deploy${" pad".repeat(index * 2)}`,
      });
    }
    await fixture.settle();
    const search = (request: SessionSearchRequest): unknown =>
      fixture.services().sessionSearch.search(request);
    const held = readEveryHit((request) => fixture.services().sessionSearch.search(request), {
      query: "deploy",
    });
    expect(held.map((hit) => hit.sessionId)).toEqual(
      [1, 2, 3, 3, 4, 5, 6].map((index) => sessionIdOf(index)),
    );

    const firstPage = SessionSearchResponseSchema.parse(search({ query: "deploy", limit: 2 }));
    if (!firstPage.hasMore) {
      throw new Error("The search pages.");
    }
    expect(shownHitsOf([firstPage.groups])).toEqual(held.slice(0, 2));
    // Between pages: the newest session is purged and a new one takes its rowids, a held title is
    // renamed so its word moves, a session on a later page is purged, and a new row matches.
    purgeSession(database, sessionIdOf(6));
    insertSession(database, sessionIdOf(7));
    insertEvent(database, {
      sessionId: sessionIdOf(7),
      sequence: 0,
      type: "user.message",
      message: "deploy",
    });
    database
      .prepare("UPDATE sessions SET name = ? WHERE id = ?")
      .run("plan doc notes for review deploy", sessionIdOf(3));
    purgeSession(database, sessionIdOf(4));
    insertEvent(database, {
      sessionId: sessionIdOf(1),
      sequence: 1,
      type: "user.message",
      message: "deploy",
    });
    // The index applies the writes and the daemon deletes the outbox rows, while the search holds.
    await fixture.settle();

    const laterPages = readPagesFrom(search, {
      query: "deploy",
      limit: 2,
      afterCursor: firstPage.nextCursor,
    });
    const gone = new Set<SessionId>([sessionIdOf(4), sessionIdOf(6)]);
    expect(shownHitsOf(laterPages)).toEqual(
      held
        .slice(2)
        .filter((hit) => !gone.has(hit.sessionId))
        .map((hit) =>
          hit.line === "deploy plan doc notes for review"
            ? { ...hit, line: "plan doc notes for review deploy" }
            : hit,
        ),
    );
    const renamedTitle = laterPages
      .flat()
      .flatMap((group) => group.hits)
      .find((hit) => hit.line === "plan doc notes for review deploy");
    expect(renamedTitle?.matchRanges).toEqual([{ start: 26, end: 32 }]);
  });

  it("reads on past sessions whose hits are all gone once a page is full, past a session's gone hits to its later ones, and pages to the end", async () => {
    const { database } = fixture;
    // Rows no query here finds, so the searched word is rare enough to score above zero.
    insertSession(database, sessionIdOf(99));
    for (let sequence = 0; sequence < 60; sequence += 1) {
      insertEvent(database, {
        sessionId: sessionIdOf(99),
        sequence,
        type: "user.message",
        message: "unrelated words",
      });
    }
    // Each session's message is longer than the last, so the sessions rank in order.
    const sessionIndexes = Array.from({ length: 40 }, (_, place) => place + 1);
    for (const index of sessionIndexes) {
      insertSession(database, sessionIdOf(index));
      insertEvent(database, {
        sessionId: sessionIdOf(index),
        sequence: 0,
        type: "user.message",
        message: `deploy${" pad".repeat(index)}`,
      });
    }
    // The last session ranks below every other and holds one more matching row than a page of
    // sixteen reads of it at once.
    const lastIndex = sessionIndexes.length + 1;
    insertSession(database, sessionIdOf(lastIndex));
    for (let sequence = 0; sequence < 18; sequence += 1) {
      insertEvent(database, {
        sessionId: sessionIdOf(lastIndex),
        sequence,
        type: "user.message",
        message: `deploy${" pad".repeat(lastIndex + sequence)}`,
      });
    }
    await fixture.settle();
    // The first read's sixteen sessions fill a page of sixteen. The next sixteen lost their rows
    // after the index saw them, so the read after that full page finds no hit at all.
    const emptiedIndexes = sessionIndexes.slice(16, 32);
    for (const index of emptiedIndexes) {
      database.prepare("DELETE FROM session_events WHERE session_id = ?").run(sessionIdOf(index));
    }
    // Every row of the last session but its lowest ranked is gone, so its one hit is found only
    // past the seventeen rows read of it first.
    database
      .prepare("DELETE FROM session_events WHERE session_id = ? AND sequence < 17")
      .run(sessionIdOf(lastIndex));

    const hits = readEveryHit((request) => fixture.services().sessionSearch.search(request), {
      query: "deploy",
      limit: 16,
    });

    expect(hits.map((hit) => hit.sessionId)).toEqual(
      [...sessionIndexes, lastIndex]
        .filter((index) => !emptiedIndexes.includes(index))
        .map((index) => sessionIdOf(index)),
    );
  });

  it("lets the least recently paged search go past its bound, refusing a cursor no search holds", async () => {
    for (const index of [1, 2]) {
      const sessionId = sessionIdOf(index);
      insertSession(fixture.database, sessionId);
      insertEvent(fixture.database, {
        sessionId,
        sequence: 0,
        type: "user.message",
        message: "retry",
      });
      insertTag(fixture.database, sessionId, "billing");
    }
    await fixture.settle();
    const { sessionSearch } = fixture.services();
    const heldCursorOf = (query: string): SessionSearchCursor => {
      const page = sessionSearch.search({ query, limit: 1 });
      if (!page.hasMore) {
        throw new Error("The search pages.");
      }
      return page.nextCursor;
    };
    const refusalOf = (request: SessionSearchRequest): unknown => {
      try {
        sessionSearch.search(request);
      } catch (error) {
        return error instanceof DaemonDomainError ? error.code : error;
      }
      return "answered";
    };

    const oldestCursor = heldCursorOf("retry");
    const tagCursor = heldCursorOf("tag:billing");
    // One search past the bound lets the least recently paged go.
    let newestCursor = oldestCursor;
    for (let count = 1; count < DEFAULT_SEARCH_SNAPSHOT_LIMITS.maxHeld; count += 1) {
      newestCursor = heldCursorOf("retry");
    }

    expect(refusalOf({ query: "retry", afterCursor: oldestCursor })).toBe(
      SESSION_SEARCH_CURSOR_UNRESOLVABLE_CODE,
    );
    expect(refusalOf({ query: "retry", afterCursor: tagCursor })).toBe(
      SESSION_SEARCH_CURSOR_UNRESOLVABLE_CODE,
    );
    expect(refusalOf({ query: "tag:billing", afterCursor: newestCursor })).toBe(
      SESSION_SEARCH_CURSOR_UNRESOLVABLE_CODE,
    );
    expect(
      refusalOf({ query: "retry", afterCursor: `r:${sessionIdOf(1)}:x` as SessionSearchCursor }),
    ).toBe(SESSION_SEARCH_CURSOR_UNRESOLVABLE_CODE);
    expect(refusalOf({ query: "tag:billing", afterCursor: tagCursor })).toBe("answered");
    expect(refusalOf({ query: "retry", afterCursor: newestCursor })).toBe("answered");
  });

  it("keeps every page inside one message, whole sessions first and one too large split", async () => {
    const { database } = fixture;
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
    await fixture.settle();

    const pages = readPagesFrom((request) => fixture.services().sessionSearch.search(request), {
      query: "retry",
    });
    const hits = shownHitsOf(pages);
    expect(hits).toHaveLength(300 + 4 * 50);
    expect(new Set(hits.map((hit) => `${hit.sessionId} ${hit.cursor}`)).size).toBe(hits.length);
    // The large session alone overflows a message and goes on into the next, where whole sessions
    // follow until the next one would overflow it.
    expect(pages.map((groups) => groups.map((group) => group.sessionId))).toEqual([
      [large],
      [large, sessionIdOf(1), sessionIdOf(2), sessionIdOf(3)],
      [sessionIdOf(4)],
    ]);
  });
});
