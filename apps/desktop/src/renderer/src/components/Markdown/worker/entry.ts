// The markdown worker: makes each reply's markdown the page sends into HTML under the screen's
// policy, and reads each drawn part it sends back into the text it copies as, with its HTML when it
// is copied as markdown, asking the page for a long table's undrawn rows as it reads them, off the
// page's thread, and moves what it made back as the UTF-8 bytes of its pieces. A request it cannot
// answer is answered with the reason, and the worker goes on with the rest.

import { MarkdownWorkerAnswers } from "./answer.js";
import type { MarkdownWorkerMessage, MarkdownWorkerReply } from "./messages.js";

/** The parts of a dedicated worker's global scope this script uses; the DOM types lack them. */
interface MarkdownWorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<MarkdownWorkerMessage>) => void,
  ): void;
  postMessage(reply: MarkdownWorkerReply, transfer: readonly Transferable[]): void;
}

// The script runs only as a dedicated worker, whose global scope is this shape.
const workerScope = globalThis as unknown as MarkdownWorkerScope;

const answers = new MarkdownWorkerAnswers((reply, transfer) => {
  workerScope.postMessage(reply, transfer);
});

workerScope.addEventListener("message", (event) => {
  answers.hear(event.data);
});
