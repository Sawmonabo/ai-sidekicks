// The markdown worker: makes each reply's markdown the page sends into HTML under the screen's
// policy, and reads each drawn part it sends back into the text it copies as, off the page's
// thread, one at a time, and moves what it made back as the UTF-8 bytes of its pieces. A request it
// cannot answer is answered with the reason, and the worker goes on to the next.

import { describeFailure } from "#shared/failure-message.js";
import { answerMarkdownRequest } from "./answer.js";
import type { MarkdownWorkerReply, MarkdownWorkerRequest } from "./messages.js";

/** The parts of a dedicated worker's global scope this script uses; the DOM types lack them. */
interface MarkdownWorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<MarkdownWorkerRequest>) => void,
  ): void;
  postMessage(reply: MarkdownWorkerReply, transfer: readonly Transferable[]): void;
}

// The script runs only as a dedicated worker, whose global scope is this shape.
const workerScope = globalThis as unknown as MarkdownWorkerScope;

workerScope.addEventListener("message", (event) => {
  const request = event.data;
  try {
    const text = answerMarkdownRequest(request);
    workerScope.postMessage({ status: "made", requestId: request.requestId, text }, text);
  } catch (error: unknown) {
    workerScope.postMessage(
      { status: "failed", requestId: request.requestId, reason: describeFailure(error) },
      [],
    );
  }
});
