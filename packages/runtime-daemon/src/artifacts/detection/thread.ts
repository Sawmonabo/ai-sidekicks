// Reads a payload's media type on a thread of its own, one thread per payload: detection parses
// untrusted bytes, and a parser stuck in a loop never yields, so no timer on its own thread could
// stop it. The daemon's main thread waits with a time bound and terminates the detection thread at
// it, so a payload that holds the parser fails its own ingest and the daemon goes on answering.
//
// - Each thread is ended before its wait settles, so none outlives its payload, and its heap is
//   bounded, so a parser that allocates without end fails its payload, not the daemon's memory.
// - Only a few threads run at once and a bounded number wait their turn; a call past that is
//   refused at once, so a burst of payloads neither starts a thread each nor queues without end.
// - The time bound runs from a thread's start, so time spent waiting for one is not counted.

import { Worker } from "node:worker_threads";

import pLimit from "p-limit";

import { moduleUrlBeside } from "../../worker/module-url.js";

const WORKER_URL = moduleUrlBeside(import.meta.url, "worker");

/**
 * How long one detection may take, thread start included, in milliseconds: the parser's own work
 * on 4100 bytes takes well under a millisecond, and the rest is the thread's start.
 */
const DETECTION_TIMEOUT_MS = 2_000;

// The detection thread's heap bounds.
const MAX_OLD_GENERATION_MB = 32;
const MAX_YOUNG_GENERATION_MB = 4;

// How many detection threads run at once, and how many calls may wait for one.
const MAX_RUNNING_DETECTIONS = 4;
const MAX_WAITING_DETECTIONS = 16;

/** Reads a media type from a payload's leading bytes, or `undefined` when they name none. */
export type MediaTypeDetector = (leadingBytes: Uint8Array) => Promise<string | undefined>;

/** A module the detection thread loads its detector from in place of the `file-type` one. */
export interface MediaTypeDetectorModule {
  readonly detectMediaType: MediaTypeDetector;
}

/** What one detection thread starts with. */
export interface DetectionThreadWorkerData {
  readonly leadingBytes: Uint8Array;
  /** The URL of a module whose detector the thread runs; absent, it runs `file-type`'s. */
  readonly detectorModuleUrl: string | undefined;
}

/** What a detection thread posts back once, before it ends. */
export type DetectionThreadReply =
  | { readonly type: "detected"; readonly mediaType: string | undefined }
  | { readonly type: "failed"; readonly message: string };

/**
 * The detector ran over the bytes and threw: the same bytes fail the same way. Every other failure
 * of a detection (its time bound, its thread failing or running out of heap, a full queue, a
 * stopped detector) says nothing about the bytes.
 */
export class DetectorRejectedBytesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DetectorRejectedBytesError";
  }
}

/** The type detector the ingest pipeline runs, each call on a thread of its own. */
export class ThreadedTypeDetector {
  readonly #detectorModuleUrl: string | undefined;
  readonly #limitThreads = pLimit({ concurrency: MAX_RUNNING_DETECTIONS, rejectOnClear: true });
  readonly #liveWorkers = new Set<Worker>();
  #isStopped = false;

  /** `detectorModuleUrl` swaps the detector each thread runs for that module's. */
  constructor(detectorModuleUrl?: URL) {
    this.#detectorModuleUrl = detectorModuleUrl?.href;
  }

  /**
   * Reads `leadingBytes`' type on a thread of its own. Rejects with
   * {@link DetectorRejectedBytesError} when the detector threw, and with a plain `Error` when the
   * detection ran past its time bound, its thread failed, too many calls are waiting, or the
   * detector was stopped; the thread is ended before either.
   */
  detect(leadingBytes: Uint8Array): Promise<string | undefined> {
    if (this.#isStopped) {
      return Promise.reject(new Error("The type detector has stopped"));
    }
    const limit = this.#limitThreads;
    if (limit.activeCount + limit.pendingCount >= MAX_RUNNING_DETECTIONS + MAX_WAITING_DETECTIONS) {
      return Promise.reject(new Error("Too many payloads are waiting for a type detection thread"));
    }
    return limit(() => this.#detectOnThread(leadingBytes));
  }

  /** Refuses every waiting call and terminates every running thread; later calls are refused. */
  async stop(): Promise<void> {
    this.#isStopped = true;
    this.#limitThreads.clearQueue();
    await Promise.all([...this.#liveWorkers].map((worker) => worker.terminate()));
  }

  // Reads one payload's type on a thread started for it, ended before the returned promise settles.
  #detectOnThread(leadingBytes: Uint8Array): Promise<string | undefined> {
    return new Promise<string | undefined>((resolve, reject) => {
      const workerData: DetectionThreadWorkerData = {
        leadingBytes,
        detectorModuleUrl: this.#detectorModuleUrl,
      };
      const worker = new Worker(WORKER_URL, {
        workerData,
        resourceLimits: {
          maxOldGenerationSizeMb: MAX_OLD_GENERATION_MB,
          maxYoungGenerationSizeMb: MAX_YOUNG_GENERATION_MB,
        },
      });
      this.#liveWorkers.add(worker);
      let isSettled = false;
      // Ends the thread, then settles with `outcome`, or with the termination's own failure.
      const settle = (outcome: () => void): void => {
        if (isSettled) {
          return;
        }
        isSettled = true;
        clearTimeout(deadline);
        worker
          .terminate()
          .finally(() => this.#liveWorkers.delete(worker))
          .then(outcome, reject);
      };
      const deadline = setTimeout(() => {
        settle(() => {
          reject(new Error(`Type detection ran past ${String(DETECTION_TIMEOUT_MS)} ms`));
        });
      }, DETECTION_TIMEOUT_MS);
      worker.once("message", (reply: DetectionThreadReply) => {
        settle(() => {
          if (reply.type === "detected") {
            resolve(reply.mediaType);
          } else {
            reject(new DetectorRejectedBytesError(reply.message));
          }
        });
      });
      worker.once("error", (error) => {
        settle(() => {
          reject(error);
        });
      });
      worker.once("exit", (code) => {
        settle(() => {
          reject(new Error(`The type detection thread exited with code ${String(code)}`));
        });
      });
    });
  }
}
