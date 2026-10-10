// The markdown worker: makes each text the page sends into HTML under the screen's policy, or into
// the body rows of the one table it makes, off the page's thread, one at a time, and sends back the
// HTML as UTF-8 bytes it moves, or the rows. A text it cannot make into either is answered with the
// reason, and the worker goes on to the next.

import { describeFailure } from "#shared/failure-message.js";
import { markdownTableBodyRows, markdownToHtml } from "../html.js";
import type { MarkdownWorkerReply, MarkdownWorkerRequest } from "./messages.js";

/** The parts of a dedicated worker's global scope this script uses; the DOM types lack them. */
interface MarkdownWorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<MarkdownWorkerRequest>) => void,
  ): void;
  postMessage(reply: MarkdownWorkerReply, transfer: Transferable[]): void;
}

// The script runs only as a dedicated worker, whose global scope is this shape.
const workerScope = globalThis as unknown as MarkdownWorkerScope;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

workerScope.addEventListener("message", (event) => {
  const { kind, requestId, source } = event.data;
  try {
    const markdown = decoder.decode(source);
    if (kind === "table-rows") {
      workerScope.postMessage(
        { status: "table-rows", requestId, rows: markdownTableBodyRows(markdown) },
        [],
      );
      return;
    }
    const html = encoder.encode(markdownToHtml(markdown)).buffer;
    workerScope.postMessage({ status: "html", requestId, html }, [html]);
  } catch (error: unknown) {
    workerScope.postMessage({ status: "failed", requestId, reason: describeFailure(error) }, []);
  }
});
