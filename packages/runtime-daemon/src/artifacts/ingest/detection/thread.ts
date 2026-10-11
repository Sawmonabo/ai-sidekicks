// Reads a payload's media type on a thread of its own, one thread per payload: detection parses
// untrusted bytes, and a parser stuck in a loop never yields, so no timer on its own thread could
// stop it. The daemon's main thread waits with a time bound and terminates the detection thread at
// it, so a payload that holds the parser fails its own ingest and the daemon goes on answering.
// The thread is ended before the wait settles either way, so none outlives its payload, and only a
// few run at once, so a batch of attachments queues for threads rather than starting one per file.

import { Worker } from "node:worker_threads";

import pLimit from "p-limit";

import { moduleUrlBeside } from "../../../worker/module-url.js";

const WORKER_URL = moduleUrlBeside(import.meta.url, "worker");

/**
 * How long one detection may take, thread start included, in milliseconds: the parser's own work
 * on 4100 bytes takes well under a millisecond, and the rest is the thread's start. The bound runs
 * from the thread's start, so time spent queued for a thread is not counted against it.
 */
const DETECTION_TIMEOUT_MS = 2_000;

// The detection thread's heap bounds: a parser that allocates without end runs out of room and
// fails its payload, never the daemon's memory.
const MAX_OLD_GENERATION_MB = 32;
const MAX_YOUNG_GENERATION_MB = 4;

// How many detection threads one detector runs at once; the rest wait their turn.
const MAX_CONCURRENT_DETECTIONS = 4;

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
 * The detector the ingest pipeline runs, each call on a thread of its own. It rejects when the
 * detector threw, the thread failed, or the detection ran past its time bound, the thread being
 * terminated first. Only a few threads run at once per detector; later calls queue.
 * `detectorModuleUrl` swaps the detector the thread runs.
 */
export function createThreadedDetector(detectorModuleUrl?: URL): MediaTypeDetector {
  const limitThreads = pLimit(MAX_CONCURRENT_DETECTIONS);
  return (leadingBytes) => limitThreads(() => detectOnThread(leadingBytes, detectorModuleUrl));
}

// Reads one payload's type on a thread started for it, ended before the returned promise settles.
function detectOnThread(
  leadingBytes: Uint8Array,
  detectorModuleUrl: URL | undefined,
): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve, reject) => {
    const workerData: DetectionThreadWorkerData = {
      leadingBytes,
      detectorModuleUrl: detectorModuleUrl?.href,
    };
    const worker = new Worker(WORKER_URL, {
      workerData,
      resourceLimits: {
        maxOldGenerationSizeMb: MAX_OLD_GENERATION_MB,
        maxYoungGenerationSizeMb: MAX_YOUNG_GENERATION_MB,
      },
    });
    let isSettled = false;
    // Ends the thread, then settles with `outcome`, or with the termination's own failure.
    const settle = (outcome: () => void): void => {
      if (isSettled) {
        return;
      }
      isSettled = true;
      clearTimeout(deadline);
      worker.terminate().then(outcome, reject);
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
          reject(new Error(reply.message));
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
