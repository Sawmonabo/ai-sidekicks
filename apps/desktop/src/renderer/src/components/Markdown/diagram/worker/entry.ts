// The diagram worker: loads merman once and draws each diagram the page asks for, one at a time,
// so no drawing runs on the page's thread. It loads no face: the page measures the labels a
// drawing needs and the worker keeps the widths. When merman fails to load, or fails in a way that
// leaves it unusable, the reply says so and the page ends this worker and starts another.

import { initMerman } from "@mermanjs/web-render";

import { describeLibraryFailure, drawMeasuredDiagram } from "./drawing.js";
import {
  LABEL_WAIT_MS,
  type DiagramDrawReply,
  type DiagramWorkerReply,
  type DiagramWorkerRequest,
  type LabelMeasureAnswer,
  type LabelMeasureRequest,
} from "./messages.js";
import { LabelWidths } from "./text-measurer.js";

/** The parts of a dedicated worker's global scope this script uses; the DOM types lack them. */
interface DiagramWorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<DiagramWorkerRequest>) => void,
  ): void;
  postMessage(reply: DiagramWorkerReply): void;
}

/** The worker's asks for label widths, each waiting at most `LABEL_WAIT_MS` for the page. */
class PageLabelAsks {
  readonly #labelWidths: LabelWidths;
  readonly #post: (reply: DiagramWorkerReply) => void;
  /** Each ask still waiting, by its id, with how to end its wait. */
  readonly #waiting = new Map<number, (isAnswered: boolean) => void>();
  #askCount = 0;

  public constructor(labelWidths: LabelWidths, post: (reply: DiagramWorkerReply) => void) {
    this.#labelWidths = labelWidths;
    this.#post = post;
  }

  /**
   * Ask for `labels` on behalf of drawing `requestId`; resolves whether the page answered in time.
   */
  public ask(requestId: number, labels: readonly LabelMeasureRequest[]): Promise<boolean> {
    this.#askCount += 1;
    const askId = this.#askCount;
    return new Promise((resolve) => {
      const wait = setTimeout(() => {
        this.#waiting.delete(askId);
        resolve(false);
      }, LABEL_WAIT_MS);
      this.#waiting.set(askId, (isAnswered) => {
        clearTimeout(wait);
        resolve(isAnswered);
      });
      this.#post({ status: "measure-labels", askId, requestId, labels });
    });
  }

  /** Keep what the page measured, which a late answer still fills for the next drawing. */
  public hear(answer: LabelMeasureAnswer): void {
    this.#labelWidths.fill(answer.measurements);
    const endWait = this.#waiting.get(answer.askId);
    this.#waiting.delete(answer.askId);
    endWait?.(true);
  }
}

// The script runs only as a dedicated worker, whose global scope is this shape.
const workerScope = globalThis as unknown as DiagramWorkerScope;

const libraryLoad = initMerman();

// The page counts a drawing's deadline from here, so a slow load never reads as a stuck drawing.
void libraryLoad.then(
  () => {
    workerScope.postMessage({ status: "loaded" });
  },
  (error: unknown) => {
    workerScope.postMessage({ status: "load-failed", reason: describeLibraryFailure(error) });
  },
);

const labelWidths = new LabelWidths();
const pageLabelAsks = new PageLabelAsks(labelWidths, (reply) => {
  workerScope.postMessage(reply);
});

workerScope.addEventListener("message", (event) => {
  const request = event.data;
  if (request.kind === "label-widths") {
    pageLabelAsks.hear(request);
    return;
  }
  void libraryLoad
    .then(() =>
      drawMeasuredDiagram(
        request.source,
        request.palette,
        request.pictureKind,
        labelWidths,
        (labels) => pageLabelAsks.ask(request.requestId, labels),
      ),
    )
    .then(
      (drawing): DiagramDrawReply => ({ requestId: request.requestId, ...drawing }),
      (error: unknown): DiagramDrawReply => ({
        requestId: request.requestId,
        status: "library-failed",
        reason: describeLibraryFailure(error),
      }),
    )
    .then((reply) => {
      workerScope.postMessage(reply);
    });
});
