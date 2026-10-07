// A ranking split across the rankers' rowid ranges pages as one read's ranking does, for words
// alone and for a tag whose sessions are too many to rank through their keys; the rankers rank
// within the reads they opened, whatever commits after; and a read-ahead the index has moved past
// since its plan or its reads is refused.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  SessionSearchGroup,
  SessionSearchRequest,
  SessionSearchResponse,
} from "@ai-sidekicks/contracts/session/methods";

import { openDatabase } from "../../../../migration-runner.js";
import {
  insertEvent,
  insertGroup,
  insertSession,
  insertTag,
  sessionIdOf,
} from "../../../__fixtures__/index-rows.js";
import { indexRowidSql } from "../../../index/columns.js";
import { SessionSearchService, type WholeIndexRankingPlan } from "../../../service.js";
import { RankerPool, type SplitRanking } from "../pool.js";

// More tagged sessions than a ranking narrows to through their keys, so the tag's ranking reads
// every match with its session.
const TAGGED_SESSION_COUNT = 1_100;
const UNTAGGED_SESSION_COUNT = 200;
const GROUP_COUNT = 5;

describe("the rankers", () => {
  let folder: string;
  let writer: DatabaseType;
  let reader: DatabaseType;
  let rankers: RankerPool;
  let nextSequence = 10;

  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), "rankers-"));
    const databasePath = join(folder, "daemon.db");
    writer = openDatabase(databasePath);
    writer.transaction(() => {
      for (let group = 0; group < GROUP_COUNT; group += 1) {
        insertGroup(writer, groupIdOf(group), `retry group ${String(group)}`);
      }
      for (let index = 0; index < TAGGED_SESSION_COUNT + UNTAGGED_SESSION_COUNT; index += 1) {
        const sessionId = sessionIdOf(index + 1);
        insertSession(writer, sessionId, {
          name: index % 9 === 0 ? `retry plan ${String(index)}` : `plan ${String(index)}`,
          ...(index % 7 === 0 ? { groupId: groupIdOf(index % GROUP_COUNT) } : {}),
        });
        if (index < TAGGED_SESSION_COUNT) {
          insertTag(writer, sessionId, "billing");
        }
        for (let sequence = 1; sequence <= 2; sequence += 1) {
          insertEvent(writer, {
            sessionId,
            sequence,
            type: "assistant.message",
            content: `${"retry ".repeat(1 + ((index + sequence) % 4))}the ${"word ".repeat(index % 13)}`,
          });
        }
      }
    })();
    reader = new Database(databasePath, { readonly: true, fileMustExist: true });
    rankers = RankerPool.start(databasePath, 4);
  });

  afterAll(async () => {
    await rankers.close();
    reader.close();
    writer.close();
    await rm(folder, { recursive: true, force: true });
  });

  it("pages a ranking read in four rowid ranges as one read's ranking pages", async () => {
    for (const query of ["retr", "tag:billing retr"]) {
      const request: SessionSearchRequest = { query, limit: 50 };
      const sessionSearch = new SessionSearchService(reader);
      const plan = planOf(sessionSearch, request);
      const split = await rankWith(plan);
      // Every range holds rows, so the ranking is truly read in four parts.
      expect(
        split.ranges.map((range) => range.rowids.length > 0),
        query,
      ).toEqual([true, true, true, true]);
      const firstPage = sessionSearch.searchWithReadAhead(request, { plan, ...split });
      expect(firstPage, query).toBeDefined();
      const onOneRead = new SessionSearchService(reader);
      expect(everyPage(sessionSearch, request, firstPage), query).toEqual(
        everyPage(onOneRead, request, onOneRead.search(request)),
      );
    }
  });

  it("ranks within the reads it opened, whatever commits after", async () => {
    const plan = planOf(new SessionSearchService(reader), { query: "retr" });
    const rankerRead = rankers.openRead();
    // Time for every ranker to open its read before the write commits.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const writtenRowid = writeLogRow();

    const split = await rankerRead.rank(plan.matchExpression, false, plan.highestRowid);
    expect(split.versions).toEqual([plan.version, plan.version, plan.version, plan.version]);
    expect(split.ranges.some((range) => range.rowids.includes(writtenRowid))).toBe(false);
    const afterTheWrite = await rankWith(
      planOf(new SessionSearchService(reader), { query: "retr" }),
    );
    expect(afterTheWrite.ranges.some((range) => range.rowids.includes(writtenRowid))).toBe(true);
  });

  it("refuses a read-ahead the index moved past since its plan or since its reads", async () => {
    const request: SessionSearchRequest = { query: "retr" };
    const sessionSearch = new SessionSearchService(reader);

    const stalePlan = planOf(sessionSearch, request);
    writeLogRow();
    const readsAfterTheWrite = await rankWith(stalePlan);
    expect(
      sessionSearch.searchWithReadAhead(request, { plan: stalePlan, ...readsAfterTheWrite }),
    ).toBeUndefined();

    const readsBeforeTheWrite = await rankWith(stalePlan);
    writeLogRow();
    const currentPlan = planOf(sessionSearch, request);
    expect(
      sessionSearch.searchWithReadAhead(request, { plan: currentPlan, ...readsBeforeTheWrite }),
    ).toBeUndefined();

    const currentReads = await rankWith(currentPlan);
    expect(
      sessionSearch.searchWithReadAhead(request, { plan: currentPlan, ...currentReads }),
    ).toEqual(expect.objectContaining({ hasMore: true }));
  });

  function rankWith(plan: WholeIndexRankingPlan): Promise<SplitRanking> {
    return rankers
      .openRead()
      .rank(plan.matchExpression, plan.taggedSessions !== undefined, plan.highestRowid);
  }

  // A log row matching the words, which moves the index's version; answers its index rowid.
  function writeLogRow(): number {
    nextSequence += 1;
    insertEvent(writer, {
      sessionId: sessionIdOf(1),
      sequence: nextSequence,
      type: "assistant.message",
      content: "retry once more",
    });
    return (
      writer
        .prepare<[], number>(`SELECT ${indexRowidSql("max(rowid)", "event")} FROM session_events`)
        .pluck()
        .get() ?? 0
    );
  }
});

function groupIdOf(index: number): string {
  return `00000000-0000-4000-9000-${String(index + 1).padStart(12, "0")}`;
}

function planOf(
  sessionSearch: SessionSearchService,
  request: SessionSearchRequest,
): WholeIndexRankingPlan {
  const plan = sessionSearch.planWholeIndexRanking(request);
  if (plan === undefined) {
    throw new Error(`No ranking across the whole index is planned for ${request.query}`);
  }
  return plan;
}

// Every page of a search from its first, each later one read from the held search's cursor.
function everyPage(
  sessionSearch: SessionSearchService,
  request: SessionSearchRequest,
  firstPage: SessionSearchResponse | undefined,
): SessionSearchGroup[][] {
  const pages: SessionSearchGroup[][] = [];
  let page = firstPage;
  while (page !== undefined) {
    pages.push(page.groups);
    page = page.hasMore
      ? sessionSearch.search({ ...request, afterCursor: page.nextCursor })
      : undefined;
  }
  return pages;
}
