// The daemon's main-thread end of the search thread: it starts the thread, sends each search and
// merge to it once its index is open, and hands back the thread's answer, or the error the request
// threw as its own class. It tells the thread each time the database writer commits, so the thread
// applies the outbox, and deletes the outbox rows each durable index commit holds through the
// writer. The main thread only waits, so a search, however long it reads, holds no other call, and
// nothing waits for the index to open but a search.

import { Worker } from "node:worker_threads";

import type {
  SessionSearchRequest,
  SessionSearchResponse,
} from "@ai-sidekicks/contracts/session/methods";
import type {
  TranscriptSearchRequest,
  TranscriptSearchResponse,
} from "@ai-sidekicks/contracts/transcript/search";

import type { DatabaseWriter } from "../../../database/writer.js";
import type { ServiceLogWriter } from "../../../daemon/service-log.js";
import { moduleUrlBeside } from "../../../worker/module-url.js";
import { deleteAppliedOutbox, type AppliedOutbox } from "../index/outbox.js";
import type { SearchIndexRebuildReason } from "../index/rebuild.js";
import {
  rebuildSearchError,
  type SearchThreadAnswer,
  type SearchThreadCall,
  type SearchThreadReply,
  type SearchThreadRequest,
  type SearchThreadWorkerData,
} from "./messages.js";

const WORKER_URL = moduleUrlBeside(import.meta.url, "worker");

// A young generation smaller than Node's default keeps the thread's resident memory down, idle and
// after a large search, for a few percent of a search's speed.
const YOUNG_GENERATION_MB = 8;

/** What the search thread is started with. */
export interface SearchThreadOptions {
  /** The daemon's database file, which the thread opens read-only. */
  readonly databasePath: string;
  /** The search index's folder in the daemon's data folder. */
  readonly indexFolderPath: string;
  /** The daemon's writer: its commits start the thread's applies, and it deletes applied rows. */
  readonly writer: Pick<DatabaseWriter, "write" | "followCommits">;
  /** Where an index rebuilt at the start and a failed outbox delete are reported. */
  readonly writeServiceLog: ServiceLogWriter;
}

interface PendingReply {
  readonly accept: (answer: SearchThreadAnswer) => void;
  readonly reject: (error: Error) => void;
}

/**
 * Answers `session.search` and `transcript.search` on a thread of their own. Start it with
 * {@link SearchThread.start}, which returns while the thread still opens its index; a search waits
 * for the open. Once the open, an apply or the thread fails, every search rejects with the reason.
 */
export class SearchThread {
  /** Resolves with why the open, an apply or the thread failed; never settles otherwise. */
  readonly whenWorkerFailed: Promise<Error>;

  readonly #worker: Worker;
  readonly #writer: Pick<DatabaseWriter, "write">;
  readonly #writeServiceLog: ServiceLogWriter;
  readonly #workerFailure = Promise.withResolvers<Error>();
  // Settles once the index is open, the open or the thread has failed, or a close came first.
  readonly #openSettled = Promise.withResolvers<void>();
  readonly #exited: Promise<void>;
  readonly #pendingReplies = new Map<number, PendingReply>();
  readonly #stopFollowingCommits: () => void;
  // Told of each durable index commit, as `followIndexCommits` attached them.
  readonly #indexCommitFollowers = new Set<{ readonly onCommitted: () => void }>();
  #nextRequestId = 0;
  // The newest durable commit whose outbox rows are still to delete, and the deletes under way.
  #appliedToDelete: AppliedOutbox | undefined;
  #outboxDeletes: Promise<void> | undefined;
  #isOpen = false;
  #failure: Error | undefined;
  #closing: Promise<void> | undefined;

  private constructor(worker: Worker, options: SearchThreadOptions) {
    this.#worker = worker;
    this.#writer = options.writer;
    this.#writeServiceLog = options.writeServiceLog;
    this.whenWorkerFailed = this.#workerFailure.promise;
    this.#exited = new Promise<void>((resolve) => {
      worker.once("exit", () => {
        resolve();
      });
    });
    worker.on("message", (reply: SearchThreadReply) => {
      this.#acceptReply(reply);
    });
    worker.on("error", (error) => {
      this.#fail(error);
    });
    worker.on("exit", (code) => {
      if (this.#closing === undefined || this.#pendingReplies.size > 0) {
        this.#fail(new Error(`The search thread exited with code ${String(code)}`));
      }
    });
    this.#stopFollowingCommits = options.writer.followCommits(() => {
      this.#worker.postMessage({ type: "writes-committed" } satisfies SearchThreadRequest);
    });
  }

  /**
   * Starts the thread, which opens its own read-only connection to the database and the index,
   * building the index again in a child process when it cannot serve, and returns at once. A
   * failed open resolves {@link whenWorkerFailed} with what the open threw, and every search
   * rejects with it.
   */
  static start(options: SearchThreadOptions): SearchThread {
    const workerData: SearchThreadWorkerData = {
      databasePath: options.databasePath,
      indexFolderPath: options.indexFolderPath,
    };
    return new SearchThread(
      new Worker(WORKER_URL, {
        workerData,
        resourceLimits: { maxYoungGenerationSizeMb: YOUNG_GENERATION_MB },
      }),
      options,
    );
  }

  /** One page of a `session.search`, as the session search answers it on the thread. */
  async searchSessions(request: SessionSearchRequest): Promise<SessionSearchResponse> {
    const answer = await this.#call({ type: "session.search", request });
    if (answer.type !== "session-searched") {
      throw unexpectedReply(answer);
    }
    return answer.response;
  }

  /**
   * One page of a `transcript.search`, as the transcript search answers it on the thread; a
   * session whose history is damaged from `damagedFromSequence` on is searched before that point.
   */
  async searchTranscript(
    request: TranscriptSearchRequest,
    damagedFromSequence?: number,
  ): Promise<TranscriptSearchResponse> {
    const answer = await this.#call({ type: "transcript.search", request, damagedFromSequence });
    if (answer.type !== "transcript-searched") {
      throw unexpectedReply(answer);
    }
    return answer.response;
  }

  /** Runs one merge of the index's segments off the main thread; resolves whether more remains. */
  async mergeSegments(): Promise<boolean> {
    const answer = await this.#call({ type: "merge" });
    if (answer.type !== "merged") {
      throw unexpectedReply(answer);
    }
    return answer.isMoreToMerge;
  }

  /**
   * Calls `onCommitted` each time a batch of the outbox commits durably to the index, until the
   * detach it returns runs; a merge is no such commit.
   */
  followIndexCommits(onCommitted: () => void): () => void {
    // A fresh object, so one function attached twice detaches once per attach.
    const follower = { onCommitted };
    this.#indexCommitFollowers.add(follower);
    return () => {
      this.#indexCommitFollowers.delete(follower);
    };
  }

  /**
   * Takes no new request, lets every request taken and the merge under way finish, then closes the
   * index and the thread's connection, ends the thread and waits for the outbox deletes its last
   * commits started. A thread still opening has answered nothing: the searches waiting for its open
   * reject, and it ends a build under way and ends once the build's process has exited. A failed
   * thread is ended at once. Repeated calls share the first close.
   */
  close(): Promise<void> {
    this.#closing ??= this.#runClose();
    return this.#closing;
  }

  async #runClose(): Promise<void> {
    this.#stopFollowingCommits();
    this.#openSettled.resolve();
    if (this.#failure !== undefined) {
      await this.#worker.terminate();
    } else {
      const answer = await this.#request({ type: "close" });
      if (answer.type === "failed") {
        throw rebuildSearchError(answer.error);
      }
      if (answer.type !== "closed") {
        throw unexpectedReply(answer);
      }
      await this.#exited;
    }
    await this.#outboxDeletes;
  }

  // A request's answer, once the index is open; a request that threw rejects with what it threw.
  async #call(call: SearchThreadCall): Promise<SearchThreadAnswer> {
    if (!this.#isOpen) {
      await this.#openSettled.promise;
    }
    if (this.#closing !== undefined) {
      throw new Error("The search thread is closed; the request did not run");
    }
    const answer = await this.#request(call);
    if (answer.type === "failed") {
      throw rebuildSearchError(answer.error);
    }
    return answer;
  }

  #request(call: SearchThreadCall): Promise<SearchThreadAnswer> {
    if (this.#failure !== undefined) {
      return Promise.reject(this.#failure);
    }
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    const { promise, resolve, reject } = Promise.withResolvers<SearchThreadAnswer>();
    this.#pendingReplies.set(id, { accept: resolve, reject });
    try {
      this.#worker.postMessage({ ...call, id } satisfies SearchThreadRequest);
    } catch (error) {
      this.#pendingReplies.delete(id);
      throw error;
    }
    return promise;
  }

  #acceptReply(reply: SearchThreadReply): void {
    switch (reply.type) {
      case "opened":
        this.#acceptOpen(reply.rebuildReason);
        return;
      case "open-failed":
        // The thread ends itself after a failed open.
        this.#fail(rebuildSearchError(reply.error));
        return;
      case "index-applied":
        this.#deleteApplied(reply.applied);
        for (const follower of this.#indexCommitFollowers) {
          follower.onCommitted();
        }
        return;
      case "index-failed":
        this.#fail(rebuildSearchError(reply.error));
        return;
      default: {
        const pendingReply = this.#pendingReplies.get(reply.id);
        if (pendingReply === undefined) {
          this.#fail(
            new Error(`The search thread answered "${reply.type}" with no request waiting`),
          );
          return;
        }
        this.#pendingReplies.delete(reply.id);
        pendingReply.accept(reply);
      }
    }
  }

  // A close that came while the thread opened ends it, so an open reported after is no news.
  #acceptOpen(rebuildReason: SearchIndexRebuildReason | undefined): void {
    if (this.#closing !== undefined) {
      return;
    }
    if (rebuildReason !== undefined) {
      this.#writeServiceLog(`search_index_rebuilt: ${rebuildReason}`);
    }
    this.#isOpen = true;
    this.#openSettled.resolve();
  }

  // Deletes run one after another, each for the newest commit heard by then.
  #deleteApplied(applied: AppliedOutbox): void {
    this.#appliedToDelete = applied;
    this.#outboxDeletes ??= this.#runOutboxDeletes();
  }

  async #runOutboxDeletes(): Promise<void> {
    try {
      for (
        let applied = this.#appliedToDelete;
        applied !== undefined;
        applied = this.#appliedToDelete
      ) {
        this.#appliedToDelete = undefined;
        try {
          await deleteAppliedOutbox(this.#writer, applied);
        } catch (error) {
          // The rows stay, and the next commit's delete takes them with its own.
          const reason = error instanceof Error ? error.message : String(error);
          this.#writeServiceLog(`search_outbox_delete_failed: ${reason}`);
        }
      }
    } finally {
      this.#outboxDeletes = undefined;
    }
  }

  // The open, an apply or the thread has failed: the thread is ended, and every request waiting
  // and every later one fails.
  #fail(error: Error): void {
    if (this.#failure !== undefined) {
      return;
    }
    this.#failure = error;
    this.#stopFollowingCommits();
    void this.#worker.terminate();
    for (const pendingReply of this.#pendingReplies.values()) {
      pendingReply.reject(error);
    }
    this.#pendingReplies.clear();
    this.#openSettled.resolve();
    this.#workerFailure.resolve(error);
  }
}

function unexpectedReply(reply: { readonly type: string }): Error {
  return new Error(`The search thread answered out of turn with "${reply.type}"`);
}
