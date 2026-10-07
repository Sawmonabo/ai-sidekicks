// The search thread's rankers: worker threads, each with a read-only connection of its own, among
// which a broad search's ranking is split by rowid range, so its matching rows are scored at once
// rather than one after another. BM25 takes its weights from the whole index whichever range a
// row is read in, so the ranges together rank as one read does when every one saw the same index
// version; the search thread checks that before it uses them.

import { Worker } from "node:worker_threads";

import {
  WHOLE_INDEX,
  type RankedRange,
  type RankedSessionScope,
  type RowidRange,
} from "../../ranking.js";
import { rebuildError } from "../../../../worker-thread/carried-error.js";
import { workerModuleUrlBeside } from "../../../../worker-thread/module-url.js";
import type { RankerReply, RankerRequest, RankerWorkerData } from "./messages.js";

const WORKER_URL = workerModuleUrlBeside(import.meta.url);

// A young generation smaller than Node's default keeps each ranker's resident memory down; a
// ranking's rows live in typed arrays outside it.
const YOUNG_GENERATION_MB = 8;

/** A ranking split across the rankers: its ranges in rowid order, and each one's index version. */
export interface SplitRanking {
  readonly ranges: readonly RankedRange[];
  readonly versions: readonly number[];
}

/**
 * Splits rankings across a fixed number of rankers. Start it with {@link RankerPool.start}; a
 * ranking waits for every ranker's connection to open. A ranker whose open or thread fails fails
 * every ranking from then on with the reason.
 */
export class RankerPool {
  readonly #rankers: readonly Ranker[];

  private constructor(rankers: readonly Ranker[]) {
    this.#rankers = rankers;
  }

  /** Starts `count` rankers, each opening its own read-only connection to `databasePath`. */
  static start(databasePath: string, count: number): RankerPool {
    const workerData: RankerWorkerData = { databasePath };
    return new RankerPool(
      Array.from(
        { length: count },
        () =>
          new Ranker(
            new Worker(WORKER_URL, {
              workerData,
              resourceLimits: { maxYoungGenerationSizeMb: YOUNG_GENERATION_MB },
            }),
          ),
      ),
    );
  }

  /**
   * The words' ranking, each ranker reading one rowid range, with the rows these sessions and
   * their groups own when `sessions` is given. The ranges cover every rowid; `highestRowid`, the
   * index's highest when the search was planned, places their bounds. Rejects with what a ranker
   * threw.
   */
  async rank(
    matchExpression: string,
    sessions: readonly RankedSessionScope[] | undefined,
    highestRowid: number,
  ): Promise<SplitRanking> {
    // Only what a ranker reads crosses to it, since every field is copied to each one.
    const scopes = sessions?.map(({ sessionId, sessionRowid, groupId, groupIndexRowid }) => ({
      sessionId,
      sessionRowid,
      groupId,
      groupIndexRowid,
    }));
    const replies = await Promise.all(
      this.#rankers.map((ranker, index) =>
        ranker.request({
          type: "rank",
          matchExpression,
          sessions: scopes,
          range: rowidRange(highestRowid, index, this.#rankers.length),
        }),
      ),
    );
    const ranked = replies.map((reply) => {
      if (reply.type !== "ranked") {
        throw new Error(`A ranker answered "${reply.type}" to a ranking`);
      }
      return reply;
    });
    return {
      ranges: ranked.map(({ rowids, ranks, ownedRows }) =>
        ownedRows === undefined ? { rowids, ranks } : { rowids, ranks, ownedRows },
      ),
      versions: ranked.map((reply) => reply.version),
    };
  }

  /** Closes every ranker's connection and ends its thread; a failed ranker is ended at once. */
  async close(): Promise<void> {
    await Promise.all(this.#rankers.map((ranker) => ranker.close()));
  }
}

// The `index`th of `count` rowid ranges a ranking splits into: equal stretches up to
// `highestRowid`, the first from the index's lowest rowid and the last to its highest there can be.
function rowidRange(highestRowid: number, index: number, count: number): RowidRange {
  const boundAt = (position: number): number =>
    position === 0
      ? WHOLE_INDEX.low
      : position === count
        ? WHOLE_INDEX.high
        : Math.floor(((highestRowid + 1) * position) / count);
  return { low: boundAt(index), high: boundAt(index + 1) };
}

// One ranker thread: its requests wait for its open, and its replies come back in order.
class Ranker {
  readonly #worker: Worker;
  readonly #opened = Promise.withResolvers<void>();
  readonly #pendingReplies: PromiseWithResolvers<RankerReply>[] = [];
  #failure: Error | undefined;

  constructor(worker: Worker) {
    this.#worker = worker;
    // A failed open settles only through the rejection a request reads.
    this.#opened.promise.catch(() => undefined);
    worker.on("message", (reply: RankerReply) => {
      if (reply.type === "opened") {
        this.#opened.resolve();
        return;
      }
      if (reply.type === "open-failed") {
        this.#fail(rebuildError(reply.error));
        return;
      }
      const pendingReply = this.#pendingReplies.shift();
      if (pendingReply === undefined) {
        this.#fail(new Error(`A ranker answered "${reply.type}" with no request waiting`));
        return;
      }
      if (reply.type === "rank-failed") {
        pendingReply.reject(rebuildError(reply.error));
        return;
      }
      pendingReply.resolve(reply);
    });
    worker.on("error", (error) => {
      this.#fail(error);
    });
    worker.on("exit", (code) => {
      this.#fail(new Error(`A ranker exited with code ${String(code)}`));
    });
  }

  async request(request: RankerRequest): Promise<RankerReply> {
    await this.#opened.promise;
    if (this.#failure !== undefined) {
      throw this.#failure;
    }
    const reply = Promise.withResolvers<RankerReply>();
    this.#pendingReplies.push(reply);
    this.#worker.postMessage(request);
    return reply.promise;
  }

  async close(): Promise<void> {
    if (this.#failure !== undefined) {
      await this.#worker.terminate();
      return;
    }
    const reply = await this.request({ type: "close" });
    if (reply.type !== "closed") {
      throw new Error(`A ranker answered "${reply.type}" to its close`);
    }
  }

  // Fails the open, if it is still waited for, and every reply still waited for, with the reason.
  #fail(error: Error): void {
    this.#failure ??= error;
    this.#opened.reject(this.#failure);
    for (const pendingReply of this.#pendingReplies.splice(0)) {
      pendingReply.reject(this.#failure);
    }
  }
}
