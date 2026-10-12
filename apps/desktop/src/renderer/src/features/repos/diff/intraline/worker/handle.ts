// A window's one handle on the worker that aligns long replaced line pairs, so a minified line's
// comparison never holds the window's own thread. The worker starts with the first pair asked of
// it and ends as soon as no pair is pending, so a window with no long pair in flight runs none.

import { recordRejectedRequest } from "#renderer/lib/diagnostic-capture/rejected-request-record.js";
import { type IntralineSegmentPair } from "../word-alignment.js";
import type { AlignmentReply, AlignmentRequest } from "./script.js";
import AlignmentWorkerScript from "./script.js?worker";

/**
 * The alignment worker of one window, shared by every diff the window draws. Not terminal: a pair
 * asked after the worker ended, failed or was terminated starts a new one.
 */
export class AlignmentWorker {
  readonly #pendingById = new Map<number, PendingAlignment>();
  #worker: Worker | undefined;
  #nextRequestId = 0;

  /**
   * Align one pair on the worker. Rejects when the worker fails, which is recorded in the window's
   * diagnostics once per failure. Aborting `signal` drops the pair, and the promise never settles.
   */
  public align(
    previousText: string,
    nextText: string,
    signal: AbortSignal,
  ): Promise<IntralineSegmentPair> {
    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;
    return new Promise((resolve, reject) => {
      const worker = this.#started();
      const onAbort = (): void => {
        this.#settle(requestId);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#pendingById.set(requestId, {
        resolve,
        reject,
        detach: () => {
          signal.removeEventListener("abort", onAbort);
        },
      });
      const request: AlignmentRequest = { requestId, previousText, nextText };
      worker.postMessage(request);
    });
  }

  /** End the worker now, as its window closes. A pair still on it never settles. */
  public terminate(): void {
    for (const pending of this.#pendingById.values()) {
      pending.detach();
    }
    this.#pendingById.clear();
    this.#end();
  }

  #started(): Worker {
    if (this.#worker !== undefined) {
      return this.#worker;
    }
    const worker = new AlignmentWorkerScript();
    worker.addEventListener("message", (event: MessageEvent<AlignmentReply>) => {
      this.#settle(event.data.requestId)?.resolve(event.data.pair);
    });
    // A worker that cannot load or throws fails every alignment it holds; none is dropped.
    worker.addEventListener("error", (event: ErrorEvent) => {
      this.#failAll(new Error(`the intraline alignment worker failed: ${event.message}`));
    });
    worker.addEventListener("messageerror", () => {
      this.#failAll(new Error("the intraline alignment worker sent a reply that did not arrive"));
    });
    this.#worker = worker;
    return worker;
  }

  /** Take one pair off the worker, ending the worker when it was the last. */
  #settle(requestId: number): PendingAlignment | undefined {
    const pending = this.#pendingById.get(requestId);
    pending?.detach();
    this.#pendingById.delete(requestId);
    if (this.#pendingById.size === 0) {
      this.#end();
    }
    return pending;
  }

  #failAll(error: Error): void {
    recordRejectedRequest("features/repos/diff/intraline", "alignment-worker-failed", error);
    const failed = [...this.#pendingById.values()];
    this.#pendingById.clear();
    this.#end();
    for (const pending of failed) {
      pending.detach();
      pending.reject(error);
    }
  }

  #end(): void {
    this.#worker?.terminate();
    this.#worker = undefined;
  }
}

interface PendingAlignment {
  readonly resolve: (pair: IntralineSegmentPair) => void;
  readonly reject: (error: Error) => void;
  /** Stop listening for the pair's abort. */
  readonly detach: () => void;
}
