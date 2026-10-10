// What runs inside the intraline alignment worker: one alignment per request, answered with the
// request's id so the window matches each reply to its pair.

import { intralineSegments, type IntralineSegmentPair } from "./word-alignment.js";

/** One pair to align, as the window posts it. */
export interface AlignmentRequest {
  readonly requestId: number;
  readonly previousText: string;
  readonly nextText: string;
}

/** One pair's alignment, as the worker posts it back. */
export interface AlignmentReply {
  readonly requestId: number;
  readonly pair: IntralineSegmentPair;
}

/** The part of a dedicated worker's global scope this script uses; the DOM library has no type. */
interface AlignmentWorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<AlignmentRequest>) => void,
  ): void;
  postMessage(reply: AlignmentReply): void;
}

const scope = globalThis as unknown as AlignmentWorkerScope;

scope.addEventListener("message", (event) => {
  const { requestId, previousText, nextText } = event.data;
  scope.postMessage({ requestId, pair: intralineSegments(previousText, nextText) });
});
