// The daemon's main-thread end of the search thread: it starts the thread, sends each session or
// transcript search to it once its connection is open, and hands back the thread's answer, or the
// error the search threw as its own class. The main thread only waits, so a search, however long it
// reads, holds no other call, and nothing waits for the thread to load but a search.

import { Worker } from "node:worker_threads";

import type {
  SessionSearchRequest,
  SessionSearchResponse,
} from "@ai-sidekicks/contracts/session/methods";
import type {
  TranscriptSearchRequest,
  TranscriptSearchResponse,
} from "@ai-sidekicks/contracts/transcript/search";

import { workerModuleUrlBeside } from "../../../worker-thread/module-url.js";
import {
  rebuildSearchError,
  type SearchThreadReply,
  type SearchThreadRequest,
  type SearchThreadWorkerData,
} from "./messages.js";

const WORKER_URL = workerModuleUrlBeside(import.meta.url);

// A young generation smaller than Node's default keeps the thread's resident memory down, idle and
// after a large search, for a few percent of a search's speed.
const YOUNG_GENERATION_MB = 8;

interface PendingReply {
  readonly accept: (reply: SearchThreadReply) => void;
  readonly reject: (error: Error) => void;
}

/**
 * Answers `session.search` and `transcript.search` on a thread of their own. Start it with
 * {@link SearchThread.start}, which returns while the thread still loads; a search waits for the
 * thread's connection to open. Once the open or the thread fails, every search rejects with the
 * reason.
 */
export class SearchThread {
  /** Resolves with the reason if the open or the thread fails; never settles otherwise. */
  readonly whenWorkerFailed: Promise<Error>;

  readonly #worker: Worker;
  readonly #workerFailure = Promise.withResolvers<Error>();
  // Settles once the connection is open, the open or the thread has failed, or a close came first.
  readonly #openSettled = Promise.withResolvers<void>();
  readonly #exited: Promise<void>;
  // Replies come back in the order the requests went out; none goes out before the open.
  readonly #pendingReplies: PendingReply[] = [];
  #isOpen = false;
  #failure: Error | undefined;
  #closing: Promise<void> | undefined;

  private constructor(worker: Worker) {
    this.#worker = worker;
    this.whenWorkerFailed = this.#workerFailure.promise;
    this.#exited = new Promise<void>((resolve) => {
      worker.once("exit", () => {
        resolve();
      });
    });
    worker.on("message", (reply: SearchThreadReply) => {
      if (!this.#isOpen) {
        this.#acceptOpenReply(reply);
        return;
      }
      const pendingReply = this.#pendingReplies.shift();
      if (pendingReply === undefined) {
        this.#fail(new Error(`The search thread answered "${reply.type}" with no request waiting`));
        return;
      }
      pendingReply.accept(reply);
    });
    worker.on("error", (error) => {
      this.#fail(error);
    });
    worker.on("exit", (code) => {
      if (this.#closing === undefined || this.#pendingReplies.length > 0) {
        this.#fail(new Error(`The search thread exited with code ${String(code)}`));
      }
    });
  }

  /**
   * Starts the thread, which loads and then opens its own read-only connection to the database at
   * `databasePath`, and returns at once. A failed open resolves {@link whenWorkerFailed} with what
   * the open threw, and every search rejects with it.
   */
  static start(databasePath: string): SearchThread {
    const workerData: SearchThreadWorkerData = { databasePath };
    return new SearchThread(
      new Worker(WORKER_URL, {
        workerData,
        resourceLimits: { maxYoungGenerationSizeMb: YOUNG_GENERATION_MB },
      }),
    );
  }

  /** One page of a `session.search`, as the session search answers it on the thread. */
  async searchSessions(request: SessionSearchRequest): Promise<SessionSearchResponse> {
    const reply = await this.#search({ type: "session.search", request });
    if (reply.type !== "session-searched") {
      throw unexpectedReply(reply);
    }
    return reply.response;
  }

  /** One page of a `transcript.search`, as the transcript search answers it on the thread. */
  async searchTranscript(request: TranscriptSearchRequest): Promise<TranscriptSearchResponse> {
    const reply = await this.#search({ type: "transcript.search", request });
    if (reply.type !== "transcript-searched") {
      throw unexpectedReply(reply);
    }
    return reply.response;
  }

  /**
   * Takes no new search, lets every search taken finish, then closes the thread's connection and
   * ends it. A thread still loading has run no search, so it is ended at once, and the searches
   * waiting for its open reject. Repeated calls share the first close.
   */
  close(): Promise<void> {
    this.#closing ??= this.#runClose();
    return this.#closing;
  }

  async #runClose(): Promise<void> {
    if (!this.#isOpen || this.#failure !== undefined) {
      this.#openSettled.resolve();
      await this.#worker.terminate();
      return;
    }
    const reply = await this.#request({ type: "close" });
    if (reply.type === "search-failed") {
      throw rebuildSearchError(reply.error);
    }
    if (reply.type !== "closed") {
      throw unexpectedReply(reply);
    }
    await this.#exited;
  }

  // A search's reply, once the connection is open; a search that threw rejects with what it threw.
  async #search(request: SearchThreadRequest): Promise<SearchThreadReply> {
    if (!this.#isOpen) {
      await this.#openSettled.promise;
    }
    if (this.#closing !== undefined) {
      throw new Error("The search thread is closed; the search did not run");
    }
    const reply = await this.#request(request);
    if (reply.type === "search-failed") {
      throw rebuildSearchError(reply.error);
    }
    return reply;
  }

  #request(request: SearchThreadRequest): Promise<SearchThreadReply> {
    if (this.#failure !== undefined) {
      return Promise.reject(this.#failure);
    }
    const reply = this.#awaitReply();
    try {
      this.#worker.postMessage(request);
    } catch (error) {
      this.#pendingReplies.pop();
      throw error;
    }
    return reply;
  }

  // A close that came while the thread loaded has ended it, so a reply already sent is no failure.
  #acceptOpenReply(reply: SearchThreadReply): void {
    if (this.#closing !== undefined) {
      return;
    }
    if (reply.type === "opened") {
      this.#isOpen = true;
      this.#openSettled.resolve();
      return;
    }
    // The thread ends itself after a failed open.
    this.#fail(
      reply.type === "open-failed" ? rebuildSearchError(reply.error) : unexpectedReply(reply),
    );
  }

  #awaitReply(): Promise<SearchThreadReply> {
    const { promise, resolve, reject } = Promise.withResolvers<SearchThreadReply>();
    this.#pendingReplies.push({ accept: resolve, reject });
    return promise;
  }

  // The open or the thread has failed: the thread is ended, and every search waiting and every
  // later one fails.
  #fail(error: Error): void {
    if (this.#failure !== undefined) {
      return;
    }
    this.#failure = error;
    void this.#worker.terminate();
    for (const pendingReply of this.#pendingReplies.splice(0)) {
      pendingReply.reject(error);
    }
    this.#openSettled.resolve();
    this.#workerFailure.resolve(error);
  }
}

function unexpectedReply(reply: SearchThreadReply): Error {
  return new Error(`The search thread answered out of turn with "${reply.type}"`);
}
