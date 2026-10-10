// Stand-ins for the diagram worker, for suites that run where no worker can: each started worker
// keeps the drawings it was sent and answers one when the test says so.

import { expect } from "vitest";

import type { DiagramWorkerPort, DiagramWorkerStart } from "./connection.js";
import type {
  DiagramDrawReply,
  DiagramDrawRequest,
  DiagramOutcome,
  DiagramWorkerReply,
  DiagramWorkerRequest,
  DrawnDiagram,
} from "./messages.js";

/** One stand-in worker: what it was sent, whether it was ended, and how to answer. */
export class FakeDiagramWorker implements DiagramWorkerPort {
  public onmessage: ((event: MessageEvent<DiagramWorkerReply>) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;
  public onmessageerror: ((event: MessageEvent) => void) | null = null;
  public readonly requests: DiagramDrawRequest[] = [];
  public isTerminated = false;

  public postMessage(request: DiagramWorkerRequest): void {
    if (request.kind === "draw") {
      this.requests.push(request);
    }
  }

  public terminate(): void {
    this.isTerminated = true;
  }

  /** Say merman loaded, or failed to load with `failure`. */
  public load(failure?: string): void {
    const reply: DiagramWorkerReply =
      failure === undefined ? { status: "loaded" } : { status: "load-failed", reason: failure };
    this.onmessage?.(new MessageEvent("message", { data: reply }));
  }

  /**
   * Answer the latest drawing with `outcome`, with merman's deadline passing, or with
   * `libraryFailure` as the library's own failure.
   */
  public answer(outcome: DiagramOutcome | "timed-out" | { readonly libraryFailure: string }): void {
    const { requestId } = this.requests.at(-1) ?? expect.fail("the worker was sent a drawing");
    const reply: DiagramDrawReply =
      outcome === "timed-out"
        ? { requestId, status: "timed-out" }
        : "libraryFailure" in outcome
          ? { requestId, status: "library-failed", reason: outcome.libraryFailure }
          : { requestId, status: "settled", outcome };
    this.onmessage?.(new MessageEvent("message", { data: reply }));
  }
}

/** Starts stand-in workers and keeps each one it started, oldest first. */
export class FakeDiagramWorkers {
  public readonly started: FakeDiagramWorker[] = [];
  public readonly start: DiagramWorkerStart = () => {
    const worker = new FakeDiagramWorker();
    this.started.push(worker);
    return worker;
  };

  /** The worker started last, which the next drawing is sent to. */
  public latest(): FakeDiagramWorker {
    return this.started.at(-1) ?? expect.fail("a worker was started");
  }
}

/** A drawn outcome whose picture names `label`, at the size given. */
export function drawnOutcome(label: string, width = 121, height = 80): DrawnDiagram {
  return {
    kind: "drawn",
    markup: `<svg><text>${label}</text></svg>`,
    width,
    height,
    groundColor: "#ffffff",
  };
}
