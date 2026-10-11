// A markdown worker connection for a test, where no worker runs: each message is answered on the
// test's own thread as the worker answers it, each message copied and its buffers moved, as a
// message between threads is.

import { MarkdownWorkerConnection, type MarkdownWorkerPort } from "./connection.js";
import { MarkdownWorkerAnswers } from "./answer.js";
import type { MarkdownWorkerMessage, MarkdownWorkerReply } from "./messages.js";

/** A connection whose worker answers on the test's thread, its texts sliced in `view`. */
export function inThreadMarkdownWorker(view: Window): MarkdownWorkerConnection {
  return new MarkdownWorkerConnection(() => new InThreadWorker(), view);
}

/** A worker that answers each message on the thread that sent it, a microtask later. */
class InThreadWorker implements MarkdownWorkerPort {
  public onmessage: ((event: MessageEvent<MarkdownWorkerReply>) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;
  public onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly #answers = new MarkdownWorkerAnswers((reply, transfer) => {
    const received = structuredClone(reply, { transfer: [...transfer] });
    queueMicrotask(() => {
      this.onmessage?.(new MessageEvent("message", { data: received }));
    });
  });

  public postMessage(message: MarkdownWorkerMessage, transfer: Transferable[] = []): void {
    const received = structuredClone(message, { transfer });
    queueMicrotask(() => {
      this.#answers.hear(received);
    });
  }

  public terminate(): void {}
}
