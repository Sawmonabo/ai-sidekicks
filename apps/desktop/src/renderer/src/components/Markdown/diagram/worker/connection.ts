// The page's end of the diagram worker. It starts the worker on the first drawing, or earlier when
// a diagram is on its way, sends one drawing at a time, pairs each reply with its request and
// answers the worker's asks for label widths, which one page measures for every window. When
// merman fails to load, or a drawing leaves it unusable, or no reply comes well past the drawing's
// deadline, or the worker itself stops, it ends that worker and starts a new one on the next
// drawing. It never ends a worker for being idle: starting again costs a load before the next
// diagram.

import type { WorkerPort, WorkerStart } from "#renderer/lib/worker-port.js";
import type { LabelMeasurer } from "../label-measurer.js";
import type { DiagramPalette } from "../palette.js";
import {
  DRAWING_DEADLINE_MS,
  LABEL_WAIT_MS,
  type DiagramOutcome,
  type DiagramPictureKind,
  type DiagramWorkerReply,
  type DiagramWorkerRequest,
} from "./messages.js";

/** The diagram worker as the connection drives it, so a test can stand in for the worker. */
export type DiagramWorkerPort = WorkerPort<DiagramWorkerRequest, DiagramWorkerReply>;

/** Starts one diagram worker. */
export type DiagramWorkerStart = WorkerStart<DiagramWorkerRequest, DiagramWorkerReply>;

/**
 * What one drawing came to and the outcome to show. Only a settled outcome is the diagram's own
 * and may be kept; an unmeasured picture, a timed-out drawing or a failure of the drawing library
 * is the moment's.
 */
export interface DiagramDrawResult {
  readonly status: "settled" | "unmeasured" | "timed-out" | "library-failed";
  readonly outcome: DiagramOutcome;
}

/** One worker at a time, started when first needed and replaced after it fails. */
export class DiagramWorkerConnection {
  readonly #startWorker: DiagramWorkerStart;
  readonly #labelMeasurer: LabelMeasurer;
  #port: DiagramWorkerPort | undefined;
  /** Whether the current worker has loaded merman, from when a drawing's deadline counts. */
  #isLoaded = false;
  /** Ends the current worker if merman has not loaded in time. */
  #loadWatchdog: ReturnType<typeof setTimeout> | undefined;
  #inFlight: InFlightDrawing | undefined;
  #requestCount = 0;

  /** `labelMeasurer` measures the labels the worker asks for. */
  public constructor(startWorker: DiagramWorkerStart, labelMeasurer: LabelMeasurer) {
    this.#startWorker = startWorker;
    this.#labelMeasurer = labelMeasurer;
  }

  /** Starts a worker ahead of the first drawing, so merman loads meanwhile; one running stays. */
  public start(): void {
    if (this.#port === undefined) {
      this.#open();
    }
  }

  /** Draw one diagram. Never rejects; the caller sends the next drawing once this one settles. */
  public draw(
    source: string,
    palette: DiagramPalette,
    pictureKind: DiagramPictureKind,
  ): Promise<DiagramDrawResult> {
    const port = this.#port ?? this.#open();
    this.#requestCount += 1;
    const requestId = this.#requestCount;
    return new Promise((settle) => {
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const inFlight: InFlightDrawing = {
        requestId,
        // merman checks its deadline only between steps, so a drawing stuck inside one ends here.
        // An ask for label widths starts it again: the worker waits for them, then draws again.
        startDeadline: (labelWaitMs = 0) => {
          clearTimeout(watchdog);
          watchdog = setTimeout(
            () => {
              this.#fail(port, TOO_LONG_REASON);
            },
            labelWaitMs + DRAWING_DEADLINE_MS + REPLY_GRACE_MS,
          );
        },
        settle: (result) => {
          clearTimeout(watchdog);
          settle(result);
        },
      };
      this.#inFlight = inFlight;
      if (this.#isLoaded) {
        inFlight.startDeadline();
      }
      port.postMessage({ kind: "draw", requestId, source, palette, pictureKind });
    });
  }

  #open(): DiagramWorkerPort {
    const port = this.#startWorker();
    port.onmessage = (event) => {
      this.#hear(port, event.data);
    };
    port.onerror = (event) => {
      this.#fail(port, `The diagram worker stopped: ${event.message}`);
    };
    port.onmessageerror = () => {
      this.#fail(port, "The diagram worker sent a reply that could not be read");
    };
    this.#port = port;
    this.#isLoaded = false;
    this.#loadWatchdog = setTimeout(() => {
      this.#fail(port, "The diagram library did not load in time");
    }, LOAD_DEADLINE_MS);
    return port;
  }

  #hear(port: DiagramWorkerPort, reply: DiagramWorkerReply): void {
    if (port !== this.#port) {
      return;
    }
    if (reply.status === "loaded") {
      clearTimeout(this.#loadWatchdog);
      this.#isLoaded = true;
      this.#inFlight?.startDeadline();
      return;
    }
    if (reply.status === "load-failed") {
      this.#fail(port, `The diagram library failed: ${reply.reason}`);
      return;
    }
    if (reply.status === "measure-labels") {
      if (reply.requestId === this.#inFlight?.requestId) {
        this.#inFlight.startDeadline(LABEL_WAIT_MS);
      }
      void this.#labelMeasurer.measure(reply.labels).then((measurements) => {
        if (port === this.#port) {
          port.postMessage({ kind: "label-widths", askId: reply.askId, measurements });
        }
      });
      return;
    }
    if (reply.requestId !== this.#inFlight?.requestId) {
      return;
    }
    if (reply.status === "library-failed") {
      this.#fail(port, `The diagram library failed: ${reply.reason}`);
      return;
    }
    const { settle } = this.#inFlight;
    this.#inFlight = undefined;
    settle(
      reply.status === "timed-out"
        ? { status: "timed-out", outcome: { kind: "failed", reason: TOO_LONG_REASON } }
        : { status: reply.status, outcome: reply.outcome },
    );
  }

  /** End `port` and fail the drawing in flight; the next drawing starts a new worker. */
  #fail(port: DiagramWorkerPort, reason: string): void {
    if (port !== this.#port) {
      return;
    }
    port.terminate();
    clearTimeout(this.#loadWatchdog);
    this.#port = undefined;
    const inFlight = this.#inFlight;
    this.#inFlight = undefined;
    inFlight?.settle({ status: "library-failed", outcome: { kind: "failed", reason } });
  }
}

/**
 * One drawing sent and not answered: its id, how to start its deadline, given any wait for label
 * widths ahead of the drawing, and how to settle it.
 */
interface InFlightDrawing {
  readonly requestId: number;
  readonly startDeadline: (labelWaitMs?: number) => void;
  readonly settle: (result: DiagramDrawResult) => void;
}

/** How long past merman's own deadline the page waits for a reply before it ends the worker. */
const REPLY_GRACE_MS = 1000;

/**
 * How long a new worker may take to load merman, in milliseconds, from its start. A cold start
 * with its first drawing measured about 150 ms, so this leaves a heavily loaded machine plenty of
 * room while a load that never finishes still fails its drawing instead of leaving it waiting.
 */
const LOAD_DEADLINE_MS = 10_000;

/** What a drawing that ran out of time shows; it is drawn again when it is next asked for. */
const TOO_LONG_REASON = "The diagram took too long to draw";

/** The app's diagram worker, loaded from the renderer's own origin as a module. */
export function startDiagramWorker(): DiagramWorkerPort {
  return new Worker(new URL("./entry.ts", import.meta.url), { type: "module", name: "diagrams" });
}
