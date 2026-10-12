// The colorer's tokenizing thread, from the daemon's main thread. Tokenizing runs on a worker
// thread so a slow or stuck line never holds the daemon, and the thread ends after
// `IDLE_END_MS` with nothing asked, so the memory its grammars and regex engine took goes back to
// the system; the next read starts a fresh one.
//
// - One tokenization runs at a time and the rest wait their turn, since the thread runs one anyway.
//   A waiting one whose caller aborts is answered at once and lets go of its source, and its turn
//   passes without work; one already running finishes.
// - The thread's start and its grammar's load have no time limit: they are bounded work, and one
//   that fails rejects the read. Once the grammar has loaded, the worker reports progress after
//   each slice, which restarts the time limit, and marks the line it is on in shared memory. When
//   the limit passes and the line in progress has itself run past it, that line is stuck: the
//   thread is ended, a fresh one started, and the same code tokenized again with that line left
//   plain, as an over-long line is.
// - The regex engine's WebAssembly memory grows with each grammar's compiled patterns and never
//   shrinks while the thread lives, so a thread whose heap and WebAssembly memory have passed
//   `MEMORY_CEILING_BYTES` is ended once its read is answered; the next read starts a fresh one,
//   which loads only the grammars asked for from then on.
// - The heap's young generation is held small, as the search thread's is, which keeps the thread's
//   resident memory down while it runs. The old generation is left unbounded, since a cap would
//   leave a large file plain.

import { Worker } from "node:worker_threads";

import type { HighlightLanguage } from "@ai-sidekicks/contracts/highlight";
import pLimit from "p-limit";

import { rebuildError, type CarriedError } from "../worker/carried-error.js";
import { moduleUrlBeside } from "../worker/module-url.js";
import { LineProgress, readSharedClock } from "./line-progress.js";

const WORKER_URL = moduleUrlBeside(import.meta.url, "worker");

/** How long the thread stays up with nothing asked before it ends: five minutes. */
const IDLE_END_MS = 5 * 60_000;

/**
 * How long one line may take before it is left plain, in milliseconds. The slowest legitimate line
 * measured, 19,999 dense characters of Go on a fresh thread, took 300 ms, so ten times that stays
 * clear of a busy machine.
 */
const LINE_TIME_LIMIT_MS = 3_000;

/**
 * The thread's heap and WebAssembly memory past which it is ended once its read is answered:
 * 128 MiB, which keeps the thread's resident memory within the colorer's budget.
 */
const MEMORY_CEILING_BYTES = 128 * 1024 * 1024;

// A young generation smaller than Node's default keeps the thread's resident memory down while it
// tokenizes, the search thread's figure.
const YOUNG_GENERATION_MB = 8;

/** What the tokenizing thread starts with. */
export interface TokenizerWorkerData {
  /** The shared memory the worker marks each line's start and end in. */
  readonly lineProgressBuffer: SharedArrayBuffer;
  /** The URL of a module whose `beforeLine` the worker runs before each line, when present. */
  readonly lineHookModuleUrl: string | undefined;
}

/** A module the tokenizing thread runs a hook from before it tokenizes each line. */
export interface LineHookModule {
  readonly beforeLine: (line: string) => void;
}

/** One tokenization the main thread asks of the thread. */
export interface TokenizeRequest {
  readonly source: string;
  readonly language: HighlightLanguage;
  /** Offsets of lines left plain, each keeping the grammar state of the line before it. */
  readonly plainLineOffsets: readonly number[];
}

/** What the thread posts while and after it tokenizes a request. */
export type TokenizerReply =
  | { readonly type: "grammar-loaded" }
  | { readonly type: "slice-tokenized" }
  | {
      readonly type: "tokenized";
      readonly spans: Uint32Array;
      /** The thread's heap and WebAssembly memory once it tokenized, in bytes. */
      readonly memoryBytes: number;
    }
  | { readonly type: "failed"; readonly error: CarriedError };

/** Construction options for `TokenizerThread`. */
export interface TokenizerThreadOptions {
  /** How long the thread stays up with nothing asked, in ms; five minutes by default. */
  readonly idleEndMs?: number;
  /** A module whose `beforeLine` the worker runs before tokenizing each line. */
  readonly lineHookModuleUrl?: URL;
  /** The thread's memory past which it is ended once its read is answered, in bytes; 128 MiB. */
  readonly memoryCeilingBytes?: number;
}

/** A started worker and the line marks it writes. */
interface RunningWorker {
  readonly worker: Worker;
  readonly lineProgress: LineProgress;
}

/** How one run of a request on one worker ended. */
type RunOutcome =
  | { readonly type: "tokenized"; readonly spans: Uint32Array }
  | { readonly type: "stuck"; readonly offset: number };

/** The refusal of a tokenization once the tokenizer has stopped. */
function stoppedError(): Error {
  return new Error("The colorer has stopped");
}

/** What one tokenization tokenizes. */
interface TokenizeInput {
  readonly source: string;
  readonly language: HighlightLanguage;
}

/** Tokenizes code on a worker thread the daemon starts on demand and ends when it sits idle. */
export class TokenizerThread {
  readonly #idleEndMs: number;
  readonly #lineHookModuleUrl: string | undefined;
  readonly #memoryCeilingBytes: number;
  readonly #limitToOne = pLimit({ concurrency: 1, rejectOnClear: true });
  #running: RunningWorker | undefined;
  #idleEnd: NodeJS.Timeout | undefined;
  #waitingCount = 0;
  #isStopped = false;

  constructor(options: TokenizerThreadOptions = {}) {
    this.#idleEndMs = options.idleEndMs ?? IDLE_END_MS;
    this.#lineHookModuleUrl = options.lineHookModuleUrl?.href;
    this.#memoryCeilingBytes = options.memoryCeilingBytes ?? MEMORY_CEILING_BYTES;
  }

  /**
   * The packed `[offset, length, class]` spans of `source` as `language`. A line the thread cannot
   * finish within the time limit has no spans. An abort of `signal` while the tokenization waits
   * for its turn rejects with the abort's reason at once and keeps nothing of `source`; once it
   * runs it finishes. Rejects when the grammar fails to load, the thread fails, or the tokenizer is
   * stopped.
   */
  tokenize(
    source: string,
    language: HighlightLanguage,
    signal?: AbortSignal,
  ): Promise<Uint32Array> {
    if (this.#isStopped) {
      return Promise.reject(stoppedError());
    }
    if (signal?.aborted === true) {
      return Promise.reject(signal.reason as Error);
    }
    clearTimeout(this.#idleEnd);
    this.#waitingCount += 1;
    return this.#waitTurn({ source, language }, signal).finally(() => {
      this.#waitingCount -= 1;
      this.#armIdleEnd();
    });
  }

  // The waiting tokenization holds its input only in `waiting`, which a drop empties, so a dropped
  // one keeps nothing of its source while its turn comes up.
  #waitTurn(input: TokenizeInput, signal: AbortSignal | undefined): Promise<Uint32Array> {
    const waiting: { input: TokenizeInput | undefined } = { input };
    const { promise, resolve, reject } = Promise.withResolvers<Uint32Array>();
    const drop = (): void => {
      waiting.input = undefined;
      reject(signal?.reason as Error);
    };
    signal?.addEventListener("abort", drop, { once: true });
    void this.#limitToOne(async () => {
      signal?.removeEventListener("abort", drop);
      const turnInput = waiting.input;
      if (turnInput === undefined) {
        return;
      }
      waiting.input = undefined;
      resolve(await this.#tokenizeLeavingStuckLinesPlain(turnInput.source, turnInput.language));
    }).catch((error: unknown) => {
      signal?.removeEventListener("abort", drop);
      reject(error as Error);
    });
    return promise;
  }

  /** Refuses the waiting calls and ends the thread; later calls are refused. */
  async stop(): Promise<void> {
    this.#isStopped = true;
    clearTimeout(this.#idleEnd);
    this.#limitToOne.clearQueue();
    const running = this.#running;
    this.#running = undefined;
    await running?.worker.terminate();
  }

  async #tokenizeLeavingStuckLinesPlain(
    source: string,
    language: HighlightLanguage,
  ): Promise<Uint32Array> {
    const plainLineOffsets: number[] = [];
    // Each pass leaves one more line plain, so the passes end within the source's line count.
    for (;;) {
      if (this.#isStopped) {
        throw stoppedError();
      }
      const outcome = await this.#runOnce({ source, language, plainLineOffsets });
      if (outcome.type === "tokenized") {
        return outcome.spans;
      }
      plainLineOffsets.push(outcome.offset);
    }
  }

  #runOnce(request: TokenizeRequest): Promise<RunOutcome> {
    const running = this.#running ?? this.#startWorker();
    const { worker, lineProgress } = running;
    const memoryCeilingBytes = this.#memoryCeilingBytes;
    return new Promise<RunOutcome>((resolve, reject) => {
      let deadline: NodeJS.Timeout | undefined;
      const armDeadline = (delayMs: number): void => {
        clearTimeout(deadline);
        deadline = setTimeout(onDeadline, delayMs);
      };
      const settle = (finish: () => void): void => {
        clearTimeout(deadline);
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
        finish();
      };
      const endThen = (finish: () => void): void => {
        settle(() => {
          this.#endWorker(running).then(finish, reject);
        });
      };
      function onDeadline(): void {
        const line = lineProgress.readLineInProgress();
        // Between lines the thread is moving: only a line that started and has not ended is cut.
        if (line === undefined) {
          armDeadline(LINE_TIME_LIMIT_MS);
          return;
        }
        // A line that began after the slice's limit started gets its own full limit.
        const lineRunMs = readSharedClock() - line.startedAt;
        if (lineRunMs < LINE_TIME_LIMIT_MS) {
          armDeadline(LINE_TIME_LIMIT_MS - lineRunMs);
          return;
        }
        endThen(() => {
          resolve({ type: "stuck", offset: line.offset });
        });
      }
      function onMessage(reply: TokenizerReply): void {
        switch (reply.type) {
          case "grammar-loaded":
          case "slice-tokenized":
            armDeadline(LINE_TIME_LIMIT_MS);
            return;
          case "tokenized": {
            const finish = (): void => {
              resolve({ type: "tokenized", spans: reply.spans });
            };
            // Ended before the next read starts, so two threads' memory never adds up.
            if (reply.memoryBytes > memoryCeilingBytes) {
              endThen(finish);
            } else {
              settle(finish);
            }
            return;
          }
          case "failed":
            settle(() => {
              reject(rebuildError(reply.error));
            });
        }
      }
      function onError(error: Error): void {
        settle(() => {
          reject(error);
        });
      }
      function onExit(code: number): void {
        settle(() => {
          reject(new Error(`The colorer's thread exited with code ${String(code)}`));
        });
      }
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
      worker.postMessage(request);
    });
  }

  #startWorker(): RunningWorker {
    const lineProgress = new LineProgress();
    const workerData: TokenizerWorkerData = {
      lineProgressBuffer: lineProgress.buffer,
      lineHookModuleUrl: this.#lineHookModuleUrl,
    };
    const worker = new Worker(WORKER_URL, {
      workerData,
      resourceLimits: { maxYoungGenerationSizeMb: YOUNG_GENERATION_MB },
    });
    const running: RunningWorker = { worker, lineProgress };
    // A thread that ends for any reason is dropped, so the next read starts a fresh one.
    worker.once("exit", () => {
      if (this.#running === running) {
        this.#running = undefined;
      }
    });
    this.#running = running;
    return running;
  }

  async #endWorker(running: RunningWorker): Promise<void> {
    if (this.#running === running) {
      this.#running = undefined;
    }
    await running.worker.terminate();
  }

  // Once nothing waits, the thread ends after the idle time unless a read comes first.
  #armIdleEnd(): void {
    const running = this.#running;
    if (this.#waitingCount > 0 || running === undefined || this.#isStopped) {
      return;
    }
    this.#idleEnd = setTimeout(() => {
      void this.#endWorker(running);
    }, this.#idleEndMs);
    this.#idleEnd.unref();
  }
}
