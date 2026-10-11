// A markdown worker connection for a test, where no worker runs: each request is answered on the
// test's own thread as the worker answers it, the request and the answer each copied, their buffers
// moved, as a message between threads is.

import { describeFailure } from "#shared/failure-message.js";
import { MarkdownWorkerConnection, type MarkdownWorkerPort } from "./connection.js";
import { answerMarkdownRequest } from "./answer.js";
import type { MarkdownWorkerReply, MarkdownWorkerRequest } from "./messages.js";

/** A connection whose worker answers on the test's thread, its texts sliced in `view`. */
export function inThreadMarkdownWorker(view: Window): MarkdownWorkerConnection {
  return new MarkdownWorkerConnection(() => new InThreadWorker(), view);
}

/** A worker that answers each request on the thread that sent it, a task later. */
class InThreadWorker implements MarkdownWorkerPort {
  public onmessage: ((event: MessageEvent<MarkdownWorkerReply>) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;
  public onmessageerror: ((event: MessageEvent) => void) | null = null;

  public postMessage(request: MarkdownWorkerRequest, transfer: Transferable[] = []): void {
    const received = structuredClone(request, { transfer });
    queueMicrotask(() => {
      this.onmessage?.(new MessageEvent("message", { data: replyTo(received) }));
    });
  }

  public terminate(): void {}
}

/** What the worker replies to `request`. */
function replyTo(request: MarkdownWorkerRequest): MarkdownWorkerReply {
  try {
    const text = answerMarkdownRequest(request);
    return structuredClone(
      { status: "made", requestId: request.requestId, text },
      { transfer: text },
    );
  } catch (error: unknown) {
    return { status: "failed", requestId: request.requestId, reason: describeFailure(error) };
  }
}
