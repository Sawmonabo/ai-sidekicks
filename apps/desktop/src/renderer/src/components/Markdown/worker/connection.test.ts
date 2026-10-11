// The markdown worker's connection when its worker fails: a worker that stops fails every text it
// holds with the reason, so a copy waiting on it says it could not copy, and the next text starts
// a new worker that answers.

import { expect, it, vi } from "vitest";

import { decodeTextPieces, encodeTextPieces } from "#renderer/lib/text-pieces.js";
import type { MarkdownWorkerReply, MarkdownWorkerRequest } from "./messages.js";
import { MarkdownWorkerConnection, type MarkdownWorkerPort } from "./connection.js";

/** A window whose tasks run at once, where the page schedules none. */
const TASKS_AT_ONCE = {
  scheduler: { postTask: async (task: () => unknown) => task() },
} as unknown as Window;

/** A stand-in worker that keeps what it is sent and answers only when told. */
class StandInWorker implements MarkdownWorkerPort {
  public onmessage: ((event: MessageEvent<MarkdownWorkerReply>) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;
  public onmessageerror: ((event: MessageEvent) => void) | null = null;
  public readonly requests: MarkdownWorkerRequest[] = [];
  public isEnded = false;

  public postMessage(request: MarkdownWorkerRequest): void {
    this.requests.push(request);
  }

  public terminate(): void {
    this.isEnded = true;
  }

  /** Answers the request it was sent last with `html`. */
  public answer(html: string): void {
    const request = this.requests.at(-1) ?? expect.fail("the worker was sent a text");
    this.onmessage?.(
      new MessageEvent("message", {
        data: {
          status: "made",
          requestId: request.requestId,
          text: encodeTextPieces(html),
        },
      }),
    );
  }
}

it("fails every text when its worker stops, and starts a new one for the next", async () => {
  const workers: StandInWorker[] = [];
  const connection = new MarkdownWorkerConnection(() => {
    const worker = new StandInWorker();
    workers.push(worker);
    return worker;
  }, TASKS_AT_ONCE);

  const first = connection.html("# one");
  const second = connection.html("# two");
  await vi.waitFor(() => {
    expect(workers[0]?.requests).toHaveLength(2);
  });
  workers[0]?.onerror?.(new ErrorEvent("error", { message: "out of memory" }));

  const failure = new Error("The markdown worker stopped: out of memory");
  await expect(first).rejects.toStrictEqual(failure);
  await expect(second).rejects.toStrictEqual(failure);
  expect(workers[0]?.isEnded).toBe(true);

  const third = connection.html("# three");
  await vi.waitFor(() => {
    expect(workers[1]?.requests).toHaveLength(1);
  });
  const request = workers[1]?.requests[0];
  expect(request?.kind === "html" ? decodeTextPieces(request.markdown) : request).toBe("# three");
  workers[1]?.answer("<h1>three</h1>");
  expect(await third).toBe("<h1>three</h1>");
});
