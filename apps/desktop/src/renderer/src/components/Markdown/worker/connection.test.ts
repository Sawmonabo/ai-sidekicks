// The markdown worker's connection when its worker fails: a worker that stops fails every text it
// holds with the reason, so a copy waiting on it says it could not copy, and the next text starts
// a new worker that answers.

import { expect, it } from "vitest";

import type { MarkdownWorkerReply, MarkdownWorkerRequest } from "./messages.js";
import { MarkdownWorkerConnection, type MarkdownWorkerPort } from "./connection.js";

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
    const encoded = new TextEncoder().encode(html).buffer;
    this.onmessage?.(
      new MessageEvent("message", {
        data: { status: "made", requestId: request.requestId, text: encoded },
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
  });

  const first = connection.html("# one");
  const second = connection.html("# two");
  workers[0]?.onerror?.(new ErrorEvent("error", { message: "out of memory" }));

  const failure = new Error("The markdown worker stopped: out of memory");
  await expect(first).rejects.toStrictEqual(failure);
  await expect(second).rejects.toStrictEqual(failure);
  expect(workers[0]?.isEnded).toBe(true);

  const third = connection.html("# three");
  const request = workers[1]?.requests[0];
  expect(request?.kind === "html" ? new TextDecoder().decode(request.source) : request).toBe(
    "# three",
  );
  workers[1]?.answer("<h1>three</h1>");
  expect(await third).toBe("<h1>three</h1>");
});
