// The markdown worker: makes each text the page sends into HTML under the screen's policy, off the
// page's thread, one at a time, and moves the HTML back as UTF-8 bytes. A text it cannot make into
// HTML is answered with the reason, and the worker goes on to the next.

import { describeFailure } from "#shared/failure-message.js";
import { markdownToHtml } from "../html.js";
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
  const { requestId, source } = event.data;
  let html: ArrayBuffer;
  try {
    html = encoder.encode(markdownToHtml(decoder.decode(source))).buffer;
  } catch (error: unknown) {
    workerScope.postMessage({ status: "failed", requestId, reason: describeFailure(error) }, []);
    return;
  }
  workerScope.postMessage({ status: "html", requestId, html }, [html]);
});
