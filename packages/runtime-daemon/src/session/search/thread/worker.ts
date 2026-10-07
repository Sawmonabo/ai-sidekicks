// The search thread: a read-only connection of its own to the daemon's database, on which every
// session and transcript search runs, so however long a search reads, it holds this thread and
// never the daemon's main one. Searches run one at a time, in the order they were sent, and the
// searches held between pages live here. A first page's ranking across the whole index is read by
// the thread's rankers, a rowid range each, while this thread holds the page's read open and reads
// the sessions a tag keeps, and used when every range read the index the page reads; otherwise it
// is read again, and after a few tries here. The rankers start when the main thread asks, once the
// daemon listens, so their load stays out of its start, or at the first ranking that needs them.

import { availableParallelism } from "node:os";
import { parentPort, workerData, type MessagePort } from "node:worker_threads";

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

import type {
  SessionSearchRequest,
  SessionSearchResponse,
} from "@ai-sidekicks/contracts/session/methods";

import { SearchIndexVersion } from "../index/version.js";
import { loadMatchCount } from "../match-count.js";
import { SessionSearchService } from "../service.js";
import { TranscriptSearchService } from "../transcript.js";
import {
  carrySearchError,
  type SearchThreadReply,
  type SearchThreadRequest,
  type SearchThreadWorkerData,
} from "./messages.js";
import { RankerPool, rankerCountFor, type RankerRead } from "./ranker/pool.js";

// How many rankers a ranking across the whole index is split across on this machine; with none,
// every ranking runs on this thread.
const RANKER_COUNT = rankerCountFor(availableParallelism());
// How many times a split ranking is read before the search ranks on this thread: a write that
// commits between the start of this thread's read and a ranker's moves the index's version, and
// the ranking is read again.
const SPLIT_RANKING_ATTEMPTS = 3;

if (parentPort === null) {
  throw new Error("The search thread runs only as a worker thread");
}
const port: MessagePort = parentPort;
const post = (reply: SearchThreadReply): void => {
  port.postMessage(reply);
};

const { databasePath } = workerData as SearchThreadWorkerData;
let reader: DatabaseType | undefined;
try {
  reader = openSearchConnection(databasePath);
} catch (error) {
  post({ type: "open-failed", error: carrySearchError(error) });
  port.close();
}
if (reader !== undefined) {
  serve(reader);
  post({ type: "opened" });
}

// The read-only connection every search runs on, with the match count a transcript search counts
// by loaded into it. A load that fails closes the connection and throws what the load threw.
function openSearchConnection(path: string): DatabaseType {
  const connection = new Database(path, { readonly: true, fileMustExist: true });
  try {
    loadMatchCount(connection);
  } catch (error) {
    connection.close();
    throw error;
  }
  return connection;
}

function serve(connection: DatabaseType): void {
  const sessionSearch = new SessionSearchService(connection);
  const transcriptSearch = new TranscriptSearchService(connection);
  const indexVersion = new SearchIndexVersion(connection);
  let rankers: RankerPool | undefined;
  // Each request is answered once the one before it has been, though a session search waits on
  // its rankers in between.
  let answered = Promise.resolve();
  port.on("message", (request: SearchThreadRequest) => {
    answered = answered.then(() => answer(request));
  });

  async function answer(request: SearchThreadRequest): Promise<void> {
    try {
      switch (request.type) {
        case "start-rankers":
          if (RANKER_COUNT > 0) {
            rankers ??= RankerPool.start(databasePath, RANKER_COUNT);
          }
          return;
        case "session.search":
          post({ type: "session-searched", response: await searchSessions(request.request) });
          return;
        case "transcript.search":
          post({ type: "transcript-searched", response: transcriptSearch.search(request.request) });
          return;
        case "close":
          await rankers?.close();
          connection.close();
          post({ type: "closed" });
          port.close();
          return;
      }
    } catch (error) {
      post({ type: "search-failed", error: carrySearchError(error) });
    }
  }

  async function searchSessions(request: SessionSearchRequest): Promise<SessionSearchResponse> {
    for (let attempt = 0; attempt < SPLIT_RANKING_ATTEMPTS; attempt += 1) {
      const response = await searchWithinOneRead(request);
      if (response !== undefined) {
        return response;
      }
    }
    return sessionSearch.search(request);
  }

  // The page, its plan and the rankers' reads within one read of this connection. The rankers open
  // their reads the moment this one starts, before the plan reads anything, so they read the index
  // this page reads unless a write commits in that moment; `undefined` then, as the version check
  // refuses their ranking.
  async function searchWithinOneRead(
    request: SessionSearchRequest,
  ): Promise<SessionSearchResponse | undefined> {
    connection.exec("BEGIN");
    try {
      if (RANKER_COUNT === 0 || !sessionSearch.mayRankWholeIndex(request)) {
        return sessionSearch.search(request);
      }
      // A read's first statement fixes what it sees, so this one's is fixed before theirs.
      indexVersion.read();
      const pool = (rankers ??= RankerPool.start(databasePath, RANKER_COUNT));
      let rankerRead: RankerRead | undefined = pool.openRead();
      try {
        const plan = sessionSearch.planWholeIndexRanking(request);
        if (plan !== undefined) {
          const openRead = rankerRead;
          rankerRead = undefined;
          const ranking = settle(
            pool,
            openRead.rank(plan.matchExpression, plan.tagFolds.length > 0, plan.highestRowid),
          );
          // This thread reads the sessions the tag keeps while the rankers rank.
          const [split, plannedWithSessions] = await readWhileAwaiting(ranking, () =>
            sessionSearch.fillTaggedSessions(plan),
          );
          return sessionSearch.searchWithReadAhead(request, {
            plan: plannedWithSessions,
            ...split,
          });
        }
      } finally {
        if (rankerRead !== undefined) {
          await settle(pool, rankerRead.end());
        }
      }
      return sessionSearch.search(request);
    } finally {
      connection.exec("COMMIT");
    }
  }

  // What `answer` settles to and what `read` returns, `read` running on this thread meanwhile. Once
  // both have settled, a failure is thrown, and both when both failed.
  async function readWhileAwaiting<Answer, Read>(
    answer: Promise<Answer>,
    read: () => Read,
  ): Promise<[Answer, Read]> {
    const [answered, readOutcome] = await Promise.allSettled([
      answer,
      new Promise<Read>((resolve) => {
        resolve(read());
      }),
    ]);
    if (answered.status === "fulfilled" && readOutcome.status === "fulfilled") {
      return [answered.value, readOutcome.value];
    }
    const failures: unknown[] = [answered, readOutcome].flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(failures, "The rankers and this thread's read both failed");
  }

  // What the rankers answer. A ranker that fails fails this search with what it threw, and the
  // rankers are started again for the next one once the failed ones are closed, so the two sets
  // never run at once.
  async function settle<Answer>(pool: RankerPool, answer: Promise<Answer>): Promise<Answer> {
    try {
      return await answer;
    } catch (error) {
      try {
        await pool.close();
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          "A ranker failed, and closing the rankers after it failed too",
          { cause: closeError },
        );
      } finally {
        if (rankers === pool) {
          rankers = RankerPool.start(databasePath, RANKER_COUNT);
        }
      }
      throw error;
    }
  }
}
