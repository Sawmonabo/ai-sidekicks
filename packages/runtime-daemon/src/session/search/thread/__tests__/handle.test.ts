// The search thread over a real database file: searches sent while it still loads answered on the
// thread once it opens, pages continued from the search the thread holds, and each error a search
// throws reaching the wire as the refusal it was thrown as. An open that fails is reported, and
// every search fails with what it threw; a close while the thread loads ends it before it opens.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EVENT_CURSOR_UNRESOLVABLE_CODE } from "@ai-sidekicks/contracts/error";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/message";
import type { EventCursor } from "@ai-sidekicks/contracts/session/id";
import {
  SESSION_SEARCH_CURSOR_UNRESOLVABLE_CODE,
  type SessionSearchCursor,
} from "@ai-sidekicks/contracts/session/methods";

import { mapJsonRpcError } from "../../../../ipc/jsonrpc-error-mapping.js";
import { openDatabase } from "../../../migration-runner.js";
import { insertEvent, insertSession, sessionIdOf } from "../../__fixtures__/index-rows.js";
import { SearchThread } from "../handle.js";

// Every worker thread this file starts, so a test can watch the search thread's own messages and
// exit.
const startedWorkers = vi.hoisted((): import("node:worker_threads").Worker[] => []);
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  class RecordedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      startedWorkers.push(this);
    }
  }
  return { ...actual, Worker: RecordedWorker };
});

// The wire's refusal for what a search rejected with.
async function refusalOf(search: Promise<unknown>): Promise<unknown> {
  try {
    await search;
  } catch (error) {
    const { error: wireError } = mapJsonRpcError(error, 1);
    return { code: wireError.code, type: wireError.data?.type };
  }
  return "answered";
}

describe("SearchThread", () => {
  let folder: string;
  let databasePath: string;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "search-thread-"));
    databasePath = join(folder, "daemon.db");
    const database = openDatabase(databasePath);
    for (const index of [1, 2]) {
      insertSession(database, sessionIdOf(index));
      insertEvent(database, {
        sessionId: sessionIdOf(index),
        sequence: 0,
        type: "user.message",
        message: "retry again",
      });
    }
    database.close();
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it("answers on its thread and rejects each refusal as the one it was thrown as", async () => {
    // The first search goes out while the thread still loads, and waits for its open.
    const thread = SearchThread.start(databasePath);
    try {
      const firstPage = await thread.searchSessions({ query: "retry", limit: 1 });
      if (!firstPage.hasMore) {
        throw new Error("The search pages.");
      }
      const secondPage = await thread.searchSessions({
        query: "retry",
        limit: 1,
        afterCursor: firstPage.nextCursor,
      });
      expect([...firstPage.groups, ...secondPage.groups].map((group) => group.sessionId)).toEqual([
        sessionIdOf(1),
        sessionIdOf(2),
      ]);
      const transcript = await thread.searchTranscript({
        sessionId: sessionIdOf(1),
        query: "again",
      });
      expect(transcript.matchCount).toBe(1);

      expect(
        await refusalOf(
          thread.searchSessions({
            query: "retry",
            afterCursor: `r:${sessionIdOf(1)}:0` as SessionSearchCursor,
          }),
        ),
      ).toEqual({
        code: JsonRpcErrorCode.InvalidParams,
        type: SESSION_SEARCH_CURSOR_UNRESOLVABLE_CODE,
      });
      expect(
        await refusalOf(thread.searchTranscript({ sessionId: sessionIdOf(9), query: "x" })),
      ).toEqual({
        code: JsonRpcErrorCode.InvalidParams,
        type: "session.not_found",
      });
      expect(
        await refusalOf(
          thread.searchTranscript({
            sessionId: sessionIdOf(1),
            query: "again",
            beforeCursor: "not-a-position" as EventCursor,
          }),
        ),
      ).toEqual({ code: JsonRpcErrorCode.InvalidParams, type: EVENT_CURSOR_UNRESOLVABLE_CODE });
    } finally {
      await thread.close();
    }
    await expect(thread.searchSessions({ query: "retry" })).rejects.toThrow(/closed/u);
  });

  it("reports an open that fails, and fails every search with what the open threw", async () => {
    const thread = SearchThread.start(join(folder, "missing.db"));
    const waiting = thread.searchSessions({ query: "retry" }).catch((error: unknown) => error);

    const failure = await thread.whenWorkerFailed;

    expect(failure.message).toBe("unable to open database file");
    expect(await waiting).toBe(failure);
    await expect(
      thread.searchTranscript({ sessionId: sessionIdOf(1), query: "again" }),
    ).rejects.toBe(failure);
    await thread.close();
  });

  it("ends a thread still loading at once when it closes, and fails the search waiting", async () => {
    const thread = SearchThread.start(databasePath);
    const worker = startedWorkers.at(-1)!;
    const replies: unknown[] = [];
    worker.on("message", (reply) => {
      replies.push(reply);
    });
    const waiting = thread.searchSessions({ query: "retry" }).catch((error: unknown) => error);

    await thread.close();

    expect(await waiting).toMatchObject({ message: expect.stringMatching(/closed/u) });
    // Ended before it opened, and no worker is left running.
    expect(replies).toStrictEqual([]);
    expect(worker.threadId).toBe(-1);
    // A close is no failure to report.
    expect(await Promise.race([thread.whenWorkerFailed, Promise.resolve("unreported")])).toBe(
      "unreported",
    );
  });
});
