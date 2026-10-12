// The markdown worker's connection: the trees an answer holds handed over a slice at a time in the
// order the texts were sent; the parser a worker compiled handed to the page's parser, which keeps
// it whatever a later worker does, and whose own failure to start leaves the worker answering; and
// when its worker fails, a worker that stops fails every text it holds with the reason, so a copy
// waiting on it says it could not copy, and the next text starts a new worker that answers; a
// worker asking for rows the copy holds no table for fails the copy.

import type { Table, TableCell } from "mdast";
import { expect, it, vi } from "vitest";

import { decodeTextPieces, encodeTextPieces } from "#renderer/lib/text/pieces.js";
import { SLICE_MS } from "#renderer/lib/work-slices.js";
import { SteppedTasks } from "#test/helpers/stepped-tasks.js";
import { TASKS_AT_ONCE } from "#test/helpers/tasks-at-once.js";
import { PageParser } from "../parse/page-parser.js";
import { loadMarkdownParserCalls } from "../parse/parser-calls.js";
import type {
  MarkdownWorkerMessage,
  MarkdownWorkerReply,
  MarkdownWorkerRequest,
  SerializedMarkdownTree,
} from "./messages.js";
import { MarkdownWorkerConnection, type MarkdownWorkerPort } from "./connection.js";
import { IN_THREAD_TEXT_COMPRESSION, inThreadParserModule } from "./connection.test-support.js";
import { appTextCompression } from "#renderer/lib/text/compression.js";

/** A stand-in worker that keeps the requests to make a copy it is sent and answers only when told. */
class StandInWorker implements MarkdownWorkerPort {
  public onmessage: ((event: MessageEvent<MarkdownWorkerReply>) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;
  public onmessageerror: ((event: MessageEvent) => void) | null = null;
  public readonly requests: MarkdownWorkerRequest[] = [];
  public isEnded = false;

  /** The parser each load handed it, `undefined` where it was asked to compile one. */
  public readonly loads: (WebAssembly.Module | undefined)[] = [];

  public postMessage(message: MarkdownWorkerMessage): void {
    if (message.kind === "html" || message.kind === "drawn-text") {
      this.requests.push(message);
    } else if (message.kind === "load") {
      this.loads.push(message.parser);
    }
  }

  public terminate(): void {
    this.isEnded = true;
  }

  /** Says `reply` to the page. */
  public say(reply: MarkdownWorkerReply): void {
    this.onmessage?.(new MessageEvent("message", { data: reply }));
  }

  /** Answers the request it was sent last with `html`. */
  public answer(html: string): void {
    const request = this.requests.at(-1) ?? expect.fail("the worker was sent a text");
    this.onmessage?.(
      new MessageEvent("message", {
        data: {
          status: "made",
          requestId: request.requestId,
          text: encodeTextPieces([html]),
        },
      }),
    );
  }
}

/** A page parser of its own, whose start loads the app's parse module, or fails with `failure`. */
function pageParserFor(failure?: Error): PageParser {
  return new PageParser(async () => {
    if (failure !== undefined) {
      throw failure;
    }
    return await loadMarkdownParserCalls();
  });
}

/** A window that runs its scheduled tasks at once and holds its idle tasks until a case runs them. */
function idleTasksView(): { readonly view: Window; readonly runIdleTasks: () => void } {
  const idleTasks: IdleRequestCallback[] = [];
  const view = {
    ...TASKS_AT_ONCE,
    requestIdleCallback: (task: IdleRequestCallback) => {
      idleTasks.push(task);
      return idleTasks.length;
    },
  } as unknown as Window;
  return {
    view,
    runIdleTasks: () => {
      for (const task of idleTasks.splice(0)) {
        task({ didTimeout: false, timeRemaining: () => 50 });
      }
    },
  };
}

/** Waits until `parser` stands at `state`. */
async function settledAt(parser: PageParser, state: PageParser["state"]): Promise<void> {
  await vi.waitFor(() => {
    expect(parser.state).toBe(state);
  });
}

it("hands the compiled parser to the page; a worker's later load failure leaves it ready", async () => {
  const workers: StandInWorker[] = [];
  const { view, runIdleTasks } = idleTasksView();
  const pageParser = pageParserFor();
  const connection = new MarkdownWorkerConnection(
    () => {
      const worker = new StandInWorker();
      workers.push(worker);
      return worker;
    },
    view,
    pageParser,
    appTextCompression,
  );
  void connection.html("# one").catch(() => undefined);
  await vi.waitFor(() => {
    expect(workers[0]?.loads).toStrictEqual([undefined]);
  });
  const module = inThreadParserModule();
  workers[0]?.say({
    status: "compiled",
    parser: module,
    textCompression: IN_THREAD_TEXT_COMPRESSION,
  });
  // Handed over in an idle moment, never on the turn the module arrives.
  expect(pageParser.state).toBe("idle");
  runIdleTasks();
  await settledAt(pageParser, "ready");

  workers[0]?.onerror?.(new ErrorEvent("error", { message: "out of memory" }));
  const third = connection.html("# three");
  await vi.waitFor(() => {
    expect(workers[1]?.loads).toStrictEqual([module]);
  });
  workers[1]?.say({ status: "load-failed", reason: "the module did not instantiate" });
  await expect(third).rejects.toThrow("The markdown parser did not load");

  expect(pageParser.state).toBe("ready");
  expect(pageParser.parse("# kept").children.map((node) => node.type)).toStrictEqual(["heading"]);
});

it("reports a page parser that fails to start as failed, while the worker still answers", async () => {
  const worker = new StandInWorker();
  const { view, runIdleTasks } = idleTasksView();
  const pageParser = pageParserFor(new Error("the page refused the module"));
  const connection = new MarkdownWorkerConnection(
    () => worker,
    view,
    pageParser,
    appTextCompression,
  );
  const first = connection.html("# one");
  await vi.waitFor(() => {
    expect(worker.requests).toHaveLength(1);
  });
  worker.say({
    status: "compiled",
    parser: inThreadParserModule(),
    textCompression: IN_THREAD_TEXT_COMPRESSION,
  });
  runIdleTasks();
  await settledAt(pageParser, "failed");

  worker.answer("<h1>one</h1>");
  expect((await first).text).toBe("<h1>one</h1>");
  expect(pageParser.state).toBe("failed");
});

it("hands over an answer's trees a slice at a time, in the order the texts were sent", async () => {
  const tasks = new SteppedTasks();
  const worker = new StandInWorker();
  const connection = new MarkdownWorkerConnection(
    () => worker,
    tasks.window,
    pageParserFor(),
    appTextCompression,
  );
  const handed: string[] = [];
  for (const source of ["first", "second", "third"]) {
    connection.parse(source, () => {
      handed.push(source);
      // Handing the first tree over runs the slice out.
      for (const start = performance.now(); performance.now() - start <= SLICE_MS; );
    });
  }
  const treeOf = (requestId: number): SerializedMarkdownTree => ({
    requestId,
    buffer: new ArrayBuffer(8),
    dollarStandIn: undefined,
  });

  worker.say({ status: "parsed", trees: [treeOf(1), treeOf(2)] });
  expect(handed).toStrictEqual(["first"]);
  // A later answer waits behind the trees an earlier one left.
  worker.say({ status: "parsed", trees: [treeOf(3)] });
  expect(handed).toStrictEqual(["first"]);
  await tasks.runNext();
  expect(handed).toStrictEqual(["first", "second"]);
  await tasks.runNext();
  expect(handed).toStrictEqual(["first", "second", "third"]);
});

it("fails every text when its worker stops, and starts a new one for the next", async () => {
  const workers: StandInWorker[] = [];
  const connection = new MarkdownWorkerConnection(
    () => {
      const worker = new StandInWorker();
      workers.push(worker);
      return worker;
    },
    TASKS_AT_ONCE,
    pageParserFor(),
    appTextCompression,
  );

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
  expect((await third).text).toBe("<h1>three</h1>");
});

it.each([
  { asked: "a table the copy does not hold", tableKey: "other", lastIndex: 0 },
  { asked: "rows past the table's last", tableKey: "table", lastIndex: 1 },
])("fails a copy whose worker asks for $asked", async ({ tableKey, lastIndex }) => {
  const worker = new StandInWorker();
  const connection = new MarkdownWorkerConnection(
    () => worker,
    TASKS_AT_ONCE,
    pageParserFor(),
    appTextCompression,
  );
  const cell: TableCell = { type: "tableCell", children: [{ type: "text", value: "x" }] };
  const table: Table = {
    type: "table",
    align: [null],
    children: [
      { type: "tableRow", children: [cell] },
      { type: "tableRow", children: [cell] },
    ],
  };

  const copy = connection.drawnText(
    { type: "root", children: [] },
    "markdown",
    new Map([["table", table]]),
  );
  await vi.waitFor(() => {
    expect(worker.requests).toHaveLength(1);
  });
  const requestId = worker.requests[0]?.requestId ?? expect.fail("the worker was sent the copy");
  worker.say({ status: "pull", requestId, tableKey, firstIndex: 0, lastIndex });

  await expect(copy).rejects.toStrictEqual(
    new Error("The markdown worker asked for rows no copied table holds"),
  );
  expect(worker.isEnded).toBe(true);
});
