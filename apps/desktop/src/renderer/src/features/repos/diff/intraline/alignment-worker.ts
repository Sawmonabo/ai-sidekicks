// The window's handle on the worker that aligns long replaced line pairs, so a minified line's
// comparison never holds the window's own thread. One worker per handle, started on the first
// pair and ended by `terminate`.

import { type IntralineSegmentPair } from "./word-alignment.js";
import type { AlignmentReply, AlignmentRequest } from "./worker-script.js";
import AlignmentWorkerScript from "./worker-script.js?worker";

/** A dedicated worker answering line-pair alignments, each by the id its request carried. */
export class AlignmentWorker {
  readonly #worker: Worker = new AlignmentWorkerScript();
  readonly #pendingById = new Map<number, PendingAlignment>();
  #nextRequestId = 0;

  public constructor() {
    this.#worker.addEventListener("message", (event: MessageEvent<AlignmentReply>) => {
      const pending = this.#pendingById.get(event.data.requestId);
      this.#pendingById.delete(event.data.requestId);
      pending?.resolve(event.data.pair);
    });
    // A worker that cannot load or throws fails every alignment it holds; none is dropped.
    this.#worker.addEventListener("error", (event: ErrorEvent) => {
      this.#failAll(new Error(`the intraline alignment worker failed: ${event.message}`));
    });
    this.#worker.addEventListener("messageerror", () => {
      this.#failAll(new Error("the intraline alignment worker sent a reply that did not arrive"));
    });
  }

  /** Align one pair on the worker. Rejects when the worker fails. */
  public align(previousText: string, nextText: string): Promise<IntralineSegmentPair> {
    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;
    return new Promise((resolve, reject) => {
      this.#pendingById.set(requestId, { resolve, reject });
      const request: AlignmentRequest = { requestId, previousText, nextText };
      this.#worker.postMessage(request);
    });
  }

  /** End the worker. An alignment still on it never settles, since nothing reads it after. */
  public terminate(): void {
    this.#worker.terminate();
    this.#pendingById.clear();
  }

  #failAll(error: Error): void {
    for (const pending of this.#pendingById.values()) {
      pending.reject(error);
    }
    this.#pendingById.clear();
  }
}

interface PendingAlignment {
  readonly resolve: (pair: IntralineSegmentPair) => void;
  readonly reject: (error: Error) => void;
}
