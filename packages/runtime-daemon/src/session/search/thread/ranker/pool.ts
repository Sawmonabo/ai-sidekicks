// The search thread's rankers: worker threads, each with a read-only connection of its own, among
// which a broad search's ranking is split by rowid range, so its matching rows are scored at once
// rather than one after another. BM25 takes its weights from the whole index whichever range a
// row is read in, so the ranges together rank as one read does when every one saw the same index
// version; the search thread checks that before it uses them.

import { Worker } from "node:worker_threads";

import { WHOLE_INDEX, type RankedRange, type RowidRange } from "../../ranking.js";
import { rebuildError } from "../../../../worker-thread/carried-error.js";
import { workerModuleUrlBeside } from "../../../../worker-thread/module-url.js";
import type { RankerReply, RankerRequest, RankerWorkerData } from "./messages.js";

const WORKER_URL = workerModuleUrlBeside(import.meta.url);

// A young generation smaller than Node's default keeps each ranker's resident memory down; a
// ranking's rows live in typed arrays outside it.
const YOUNG_GENERATION_MB = 8;

// The most rankers a ranking is split across.
const MOST_RANKERS = 4;

// The daemon's worker threads besides the rankers: the database writer and the search thread.
const OTHER_WORKER_THREADS = 2;

/**
 * How many rankers to start on a machine with `cores` logical cores: at most four, and never so
 * many that the daemon's worker threads, rankers included, outnumber every core but one, which
 * stays the main thread's. Zero when the cores leave none for rankers.
 */
export function rankerCountFor(cores: number): number {
  return Math.max(0, Math.min(MOST_RANKERS, cores - 1 - OTHER_WORKER_THREADS));
}

/** A ranking split across the rankers: its ranges in rowid order, and each one's index version. */
export interface SplitRanking {
  readonly ranges: readonly RankedRange[];
  readonly versions: readonly number[];
}

/** The rankers' reads, opened together: ranked within once, or ended. */
export interface RankerRead {
  /**
   * The words' ranking, each ranker reading one rowid range within its read, with each row's
   * session and position when `readsSessions`; each read ends with it. The ranges cover every
   * rowid; `highestRowid`, the index's highest in the caller's read, places their bounds. Rejects
   * with what a ranker threw.
   */
  rank(
    matchExpression: string,
    readsSessions: boolean,
    highestRowid: number,
  ): Promise<SplitRanking>;
  /** Ends every ranker's read without a ranking. Rejects with what a ranker threw. */
  end(): Promise<void>;
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
   * Has every ranker open a read now, so the reads see the index as a read started at this moment
   * does; the returned read then ranks within them or ends them.
   */
  openRead(): RankerRead {
    const opened = Promise.all(
      this.#rankers.map((ranker) => ranker.request({ type: "open-read" })),
    );
    // Read by the ranking or the end, which a caller always awaits.
    opened.catch(() => undefined);
    return {
      rank: async (matchExpression, readsSessions, highestRowid) => {
        const [openReplies, rankReplies] = await Promise.all([
          opened,
          Promise.all(
            this.#rankers.map((ranker, index) =>
              ranker.request({
                type: "rank",
                matchExpression,
                readsSessions,
                range: rowidRange(highestRowid, index, this.#rankers.length),
              }),
            ),
          ),
        ]);
        return {
          ranges: rankReplies.map((reply) => {
            if (reply.type !== "ranked") {
              throw new Error(`A ranker answered "${reply.type}" to a ranking`);
            }
            const { rowids, ranks, sessionRowids, sequences } = reply;
            return sessionRowids === undefined || sequences === undefined
              ? { rowids, ranks }
              : { rowids, ranks, sessionRowids, sequences };
          }),
          versions: openReplies.map(versionOf),
        };
      },
      end: async () => {
        const [, endReplies] = await Promise.all([
          opened,
          Promise.all(this.#rankers.map((ranker) => ranker.request({ type: "end-read" }))),
        ]);
        for (const reply of endReplies) {
          if (reply.type !== "read-ended") {
            throw new Error(`A ranker answered "${reply.type}" to the end of its read`);
          }
        }
      },
    };
  }

  /** Closes every ranker's connection and ends its thread; a failed ranker is ended at once. */
  async close(): Promise<void> {
    await Promise.all(this.#rankers.map((ranker) => ranker.close()));
  }
}

// The version a ranker's open read sees.
function versionOf(reply: RankerReply): number {
  if (reply.type !== "read-opened") {
    throw new Error(`A ranker answered "${reply.type}" to the opening of its read`);
  }
  return reply.version;
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
  #isOpen = false;
  #failure: Error | undefined;

  constructor(worker: Worker) {
    this.#worker = worker;
    // A failed open settles only through the rejection a request reads.
    this.#opened.promise.catch(() => undefined);
    worker.on("message", (reply: RankerReply) => {
      if (reply.type === "opened") {
        this.#isOpen = true;
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

  // Posted at once on an open ranker, not a turn later, so a read opened before the caller's own
  // synchronous work starts while that work runs.
  request(request: RankerRequest): Promise<RankerReply> {
    return this.#isOpen
      ? this.#post(request)
      : this.#opened.promise.then(() => this.#post(request));
  }

  #post(request: RankerRequest): Promise<RankerReply> {
    if (this.#failure !== undefined) {
      return Promise.reject(this.#failure);
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
