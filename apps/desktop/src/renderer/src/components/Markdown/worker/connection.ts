// The page's end of the markdown worker, one for the whole app. It starts the worker on a sign the
// app will soon draw markdown or on the first request, and hands it the parser: the module the
// first worker compiled and sent back, which every later worker only instantiates. That module is
// handed to the page's own parser too, at an idle moment, which parses the blocks a body mounts,
// and the text-compression module the worker compiled beside it goes to the page's text codec;
// the worker parses what the page does not: a streaming tail, a block too long to parse on the
// page, a long table's pieces, and every block while the page's parser could not start. It sends
// each text to parse and hands back the parser's binary tree; a reply's markdown as the UTF-8
// bytes of its pieces, moved to the worker, or a drawn part's tree as a copy, to be made into what
// it copies as; and it answers each of the worker's asks for a long table's undrawn rows from the
// table the page drew, with the rows one slice writes, so no task on the page grows with a text or
// a table. When the worker stops, fails to load or run the parser, sends what cannot be read or an
// ask no copied table answers, or leaves a request unanswered past its deadline, it ends that
// worker and fails every request still waiting; the next request starts a new one. A worker left
// unused for a minute, with no turn holding it awake, is ended to give its memory back while the
// compiled module stays; a request sent while a new worker loads waits in the worker's own queue.

import type { Table } from "mdast";

import { recordRejectedRequest } from "#renderer/lib/diagnostic-capture/rejected-request-record.js";
import { queueIdleTaskIn } from "#renderer/lib/idle-task.js";
import type { WorkerPort, WorkerStart } from "#renderer/lib/worker-port.js";
import { queueTaskIn } from "#renderer/lib/queued-task.js";
import { appTextCompression, type TextCompression } from "#renderer/lib/text/compression.js";
import { startSlice } from "#renderer/lib/work-slices.js";
import { describeFailure } from "#shared/failure-message.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import {
  decodePiecesInSlices,
  encodePiecesInSlices,
  piecesOf,
  type PiecedText,
} from "#renderer/lib/text/pieces.js";
import { drawnTreeLength, drawnTreeText, type CopyFlavor, type DrawnTree } from "../drawn-text.js";
import { appPageParser, type PageParser } from "../parse/page-parser.js";
import { piecedRowsOf } from "../parse/pieced-table.js";
import { holdTableRows, passTableRows } from "../parse/table-rows.js";
import type {
  CompiledTextCompression,
  MarkdownCutAnswer,
  MarkdownParseAnswer,
  MarkdownWorkerMade,
  MarkdownWorkerMessage,
  MarkdownWorkerReply,
  MarkdownWorkerRequest,
} from "./messages.js";

/** What a drawn part copies as: its text, and its HTML when the worker made it with the text. */
export interface DrawnPartCopy {
  readonly text: PiecedText;
  readonly html?: PiecedText;
}

/** The markdown worker as the connection drives it, so a test can stand in for the worker. */
export type MarkdownWorkerPort = WorkerPort<MarkdownWorkerMessage, MarkdownWorkerReply>;

/** Starts one markdown worker. */
export type MarkdownWorkerStart = WorkerStart<MarkdownWorkerMessage, MarkdownWorkerReply>;

/**
 * The characters a drawn part holds, as `drawnTreeLength` counts them, from which the worker reads
 * it into its text rather than the page. Measured on a loaded machine, a table of 1 KiB took 3.4 ms
 * to rebuild as markdown on the page, which fits a 4 ms slice of copy work inside a frame, and
 * 6.1 ms at 2 KiB, which does not; prose and plain text cost less.
 */
export const PAGE_DRAWN_TEXT_CHARACTER_LIMIT = 1024;

/**
 * How long the worker may go unused, in milliseconds, before it is ended to give back its memory:
 * the parser's code and heap cost the renderer about 14 MB of physical footprint while it runs, of
 * which the compiled module the connection keeps, about 6 MB, stays, so starting again costs about
 * 15 ms, which the app hides by starting it on the first sign of use (a keystroke, a turn starting,
 * the window coming forward, a session shown, a scroll). The clock does not run while a turn runs,
 * and every request, keystroke and scroll restarts it, so a minute outlasts the pauses inside
 * ordinary use and gives the memory back soon after the person steps away.
 */
export const MARKDOWN_WORKER_IDLE_STOP_MS = 60_000;

/**
 * One worker at a time: started on a sign of use or the first request, replaced after it fails,
 * and ended after a minute unused; and one compiled parser that every worker after the first
 * instantiates, and the page's parser starts from.
 */
export class MarkdownWorkerConnection {
  /** The page's parser, which this connection hands the compiled module to. */
  public readonly pageParser: PageParser;
  /** The page's text codec, which this connection hands the text-compression module to. */
  readonly #textCompression: TextCompression;
  readonly #startWorker: MarkdownWorkerStart;
  readonly #view: Window;
  /** Each request to make a copy sent and not answered, by its id. */
  readonly #waiting = new Map<number, WaitingText>();
  /** Each text sent to parse and not answered, by its id. */
  readonly #waitingParses = new Map<number, (answer: MarkdownParseAnswer) => void>();
  /** Each text sent to cut into blocks and not answered, by its id. */
  readonly #waitingCuts = new Map<number, (answer: MarkdownCutAnswer) => void>();
  /**
   * The trees the worker answered and not yet handed over, in the order it answered them: handed
   * over a slice at a time, so an answer of thousands of trees holds no task long.
   */
  #unhandedTrees: HandedTree[] = [];
  #nextHandedIndex = 0;
  /** Whether a task is queued to hand over the trees the last slice left. */
  #isHandingQueued = false;
  #port: MarkdownWorkerPort | undefined;
  /** The parser's compiled module, kept for the app's life once a worker compiled it. */
  #parser: WebAssembly.Module | undefined;
  /** The module waiting for an idle moment to start the page's parser, while one waits. */
  #pageParserHandOff: WebAssembly.Module | undefined;
  /** Ends the current worker when it leaves a text to parse unanswered too long. */
  #parseWatchdog: ReturnType<typeof setTimeout> | undefined;
  /** Ends the current worker once it has gone unused for the idle stop. */
  #idleCheck: ReturnType<typeof setTimeout> | undefined;
  /** When the worker was last used or asked to stay up, on `performance.now()`'s clock. */
  #lastUseMs = 0;
  /** How many holds keep the worker up whatever its idle time, such as a turn that is running. */
  #holdCount = 0;
  #requestCount = 0;

  /**
   * `view` is the window whose thread encodes and decodes the texts, a slice at a time, and starts
   * `pageParser` in an idle moment; `textCompression` takes the codec module the worker compiles.
   */
  public constructor(
    startWorker: MarkdownWorkerStart,
    view: Window,
    pageParser: PageParser,
    textCompression: TextCompression,
  ) {
    this.#startWorker = startWorker;
    this.#view = view;
    this.pageParser = pageParser;
    this.#textCompression = textCompression;
  }

  /**
   * Parse `source` and hand `settle` what it came to. Never throws. `settle` is called once, after
   * this call returns unless the worker answers on the same turn, as a stand-in does.
   */
  public parse(source: string, settle: (answer: MarkdownParseAnswer) => void): void {
    this.#lastUseMs = performance.now();
    let port: MarkdownWorkerPort;
    try {
      port = this.#port ?? this.#open();
    } catch (error: unknown) {
      settle({
        status: "failed",
        reason: `The markdown worker could not start: ${describeFailure(error)}`,
      });
      return;
    }
    this.#requestCount += 1;
    const requestId = this.#requestCount;
    this.#waitingParses.set(requestId, settle);
    if (this.#waitingWorkCount === 1) {
      this.#armParseWatchdog(port);
    }
    port.postMessage({ kind: "parse", requestId, source });
  }

  /**
   * Cut `source` into blocks, its last ones too when `isFinal`, and hand `settle` where each ends.
   * Never throws. `settle` is called once, after this call returns unless the worker answers on
   * the same turn, as a stand-in does.
   */
  public cut(source: string, isFinal: boolean, settle: (answer: MarkdownCutAnswer) => void): void {
    this.#lastUseMs = performance.now();
    let port: MarkdownWorkerPort;
    try {
      port = this.#port ?? this.#open();
    } catch (error: unknown) {
      settle({
        status: "failed",
        reason: `The markdown worker could not start: ${describeFailure(error)}`,
      });
      return;
    }
    this.#requestCount += 1;
    const requestId = this.#requestCount;
    this.#waitingCuts.set(requestId, settle);
    if (this.#waitingWorkCount === 1) {
      this.#armParseWatchdog(port);
    }
    port.postMessage({ kind: "cut", requestId, source, isFinal });
  }

  /**
   * The HTML `markdown` makes under the screen's policy, made off the page's thread from `pieces`,
   * the same text in pieces, and held in pieces. Rejects with an `Error` when the worker cannot
   * start, cannot make the HTML, stops, or does not answer in time.
   */
  public async html(
    markdown: string,
    pieces: readonly string[] = piecesOf(markdown),
  ): Promise<PiecedText> {
    const encoded = await encodePiecesInSlices(pieces, this.#view);
    const made = await this.#ask(
      (requestId) => ({ kind: "html", requestId, markdown: encoded }),
      encoded,
      markdown.length,
    );
    return await decodePiecesInSlices(made.text, this.#view);
  }

  /**
   * What the drawn part `tree` copies as in `flavor`, read off the page's thread: the same text
   * `drawnTreeText` or `drawnTreeMarkdown` reads, with the HTML of a part copied as markdown, each
   * of its long tables' undrawn rows read from the table `tables` holds under the key the rows
   * name. Rejects as `html` does, and when the worker asks for rows those tables do not hold.
   */
  public async drawnText(
    tree: DrawnTree,
    flavor: CopyFlavor,
    tables: ReadonlyMap<string, Table>,
  ): Promise<DrawnPartCopy> {
    const tableAlignments = new Map(
      [...tables].map(([tableKey, table]) => [tableKey, table.align]),
    );
    const made = await this.#ask(
      (requestId) => ({ kind: "drawn-text", requestId, tree, flavor, tableAlignments }),
      [],
      drawnTreeLength(tree),
      tables,
    );
    const text = await decodePiecesInSlices(made.text, this.#view);
    return made.html === undefined
      ? { text }
      : { text, html: await decodePiecesInSlices(made.html, this.#view) };
  }

  /**
   * Start the worker now if it is not running, so it has loaded the parser by the time a text
   * comes, and count this as a use. Cheap when it runs, so a caller may call it on every keystroke
   * or scroll sample. A worker that cannot start is recorded, and the next request reports it.
   */
  public wake(): void {
    this.#lastUseMs = performance.now();
    if (this.#port !== undefined) {
      return;
    }
    try {
      this.#open();
    } catch (error: unknown) {
      recordRejectedRequest("components/Markdown/worker", "worker-not-started", error);
    }
  }

  /**
   * Keep the worker from its idle stop until the returned call releases the hold; releasing counts
   * as a use, so the idle minute starts then. It does not start a worker: pair it with `wake`.
   */
  public holdAwake(): Unsubscribe {
    this.#holdCount += 1;
    let isHeld = true;
    return () => {
      if (!isHeld) {
        return;
      }
      isHeld = false;
      this.#holdCount -= 1;
      this.#lastUseMs = performance.now();
    };
  }

  /**
   * Sends the request `requestOf` makes, moving `transfer` to the worker, and resolves what it
   * made, within the deadline of a request `size` characters long, counted again from each ask for
   * rows of `tables`.
   */
  #ask(
    requestOf: (requestId: number) => MarkdownWorkerRequest,
    transfer: readonly Transferable[],
    size: number,
    tables: ReadonlyMap<string, Table> = new Map(),
  ): Promise<MarkdownWorkerMade> {
    this.#lastUseMs = performance.now();
    let port: MarkdownWorkerPort;
    try {
      port = this.#port ?? this.#open();
    } catch (error: unknown) {
      return Promise.reject(
        new Error(`The markdown worker could not start: ${describeFailure(error)}`),
      );
    }
    this.#requestCount += 1;
    const requestId = this.#requestCount;
    return new Promise((resolve, reject) => {
      const deadlineMs = answerDeadlineMs(size);
      const watchdog = this.#watch(port, deadlineMs);
      this.#waiting.set(requestId, { resolve, reject, watchdog, deadlineMs, tables });
      port.postMessage(requestOf(requestId), [...transfer]);
    });
  }

  /** Fails `port` unless it answers within `deadlineMs`. */
  #watch(port: MarkdownWorkerPort, deadlineMs: number): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      this.#fail(port, "The markdown worker did not answer in time");
    }, deadlineMs);
  }

  #open(): MarkdownWorkerPort {
    const port = this.#startWorker();
    port.onmessage = (event) => {
      this.#hear(port, event.data);
    };
    port.onerror = (event) => {
      this.#fail(port, `The markdown worker stopped: ${event.message}`);
    };
    port.onmessageerror = () => {
      this.#fail(port, "The markdown worker sent a reply that could not be read");
    };
    this.#port = port;
    this.#armIdleCheck(port, MARKDOWN_WORKER_IDLE_STOP_MS);
    port.postMessage({ kind: "load", parser: this.#parser });
    return port;
  }

  #hear(port: MarkdownWorkerPort, reply: MarkdownWorkerReply): void {
    if (port !== this.#port) {
      return;
    }
    switch (reply.status) {
      case "compiled":
        this.#parser = reply.parser;
        this.#handToPageParser(reply.parser);
        this.#handToTextCompression(reply.textCompression);
        return;
      case "load-failed":
        // Compiled again by the next worker, since what failed may have been the module handed.
        this.#parser = undefined;
        // A page parser never handed a module fails with the worker; one handed it keeps its own.
        this.#pageParserHandOff = undefined;
        this.pageParser.fail();
        this.#fail(port, `The markdown parser did not load: ${reply.reason}`);
        return;
      case "parser-failed":
        this.#fail(port, `The markdown parser failed: ${reply.reason}`);
        return;
      case "parsed":
        this.#landTrees(port, reply.trees);
        return;
      case "cut":
        for (const cut of reply.cuts) {
          this.#landCut(port, cut.requestId, cut.blockEnds);
        }
        return;
      default:
        this.#hearMade(port, reply);
    }
  }

  /**
   * Starts the page's parser from `parser` at the view's next idle moment, unless it is started
   * already or the worker's load fails first.
   */
  #handToPageParser(parser: WebAssembly.Module): void {
    const state = this.pageParser.state;
    if (state === "loading" || state === "ready") {
      return;
    }
    this.#pageParserHandOff = parser;
    queueIdleTaskIn(this.#view, () => {
      if (this.#pageParserHandOff === parser) {
        this.#pageParserHandOff = undefined;
        this.pageParser.start(parser);
      }
    });
  }

  /**
   * Hands the page's codec the text-compression module the worker compiled, or its word that it
   * compiled none, which is recorded, and after which the page holds every chunk plain.
   */
  #handToTextCompression(textCompression: CompiledTextCompression): void {
    if (textCompression.status === "compiled") {
      this.#textCompression.provide(textCompression.module);
      return;
    }
    recordRejectedRequest(
      "components/Markdown/worker",
      "text-compression-not-compiled",
      new Error(textCompression.reason),
    );
    this.#textCompression.provide(undefined);
  }

  #landTrees(
    port: MarkdownWorkerPort,
    trees: Extract<MarkdownWorkerReply, { status: "parsed" }>["trees"],
  ): void {
    for (const tree of trees) {
      const settle = this.#waitingParses.get(tree.requestId);
      this.#waitingParses.delete(tree.requestId);
      if (settle !== undefined) {
        this.#unhandedTrees.push({
          settle,
          answer: { status: "parsed", buffer: tree.buffer, dollarStandIn: tree.dollarStandIn },
        });
      }
    }
    this.#rearmParseWatchdog(port);
    // Trees left by the last slice are handed over first, keeping the order the texts were sent.
    if (!this.#isHandingQueued) {
      this.#handTrees();
    }
  }

  #landCut(port: MarkdownWorkerPort, requestId: number, blockEnds: Uint32Array): void {
    const settle = this.#waitingCuts.get(requestId);
    this.#waitingCuts.delete(requestId);
    this.#rearmParseWatchdog(port);
    settle?.({ status: "cut", blockEnds });
  }

  /** Counts the parse watchdog's clock again from an answer, while texts still wait on it. */
  #rearmParseWatchdog(port: MarkdownWorkerPort): void {
    clearTimeout(this.#parseWatchdog);
    if (this.#waitingWorkCount > 0 && port === this.#port) {
      this.#armParseWatchdog(port);
    }
  }

  /** How many texts wait to be parsed or cut. */
  get #waitingWorkCount(): number {
    return this.#waitingParses.size + this.#waitingCuts.size;
  }

  /** Hands over answered trees until the slice runs out, and queues a task for the rest. */
  #handTrees(): void {
    const hasTime = startSlice();
    while (this.#nextHandedIndex < this.#unhandedTrees.length && hasTime()) {
      const handed = this.#unhandedTrees[this.#nextHandedIndex];
      this.#nextHandedIndex += 1;
      handed?.settle(handed.answer);
    }
    if (this.#nextHandedIndex < this.#unhandedTrees.length) {
      // A parse asked while a tree was handed over may have queued the rest already.
      if (this.#isHandingQueued) {
        return;
      }
      this.#isHandingQueued = true;
      queueTaskIn(this.#view, () => {
        this.#isHandingQueued = false;
        this.#handTrees();
      });
      return;
    }
    this.#unhandedTrees = [];
    this.#nextHandedIndex = 0;
  }

  #hearMade(
    port: MarkdownWorkerPort,
    reply: Extract<MarkdownWorkerReply, { status: "pull" | "made" | "failed" }>,
  ): void {
    const waiting = this.#waiting.get(reply.requestId);
    if (waiting === undefined) {
      return;
    }
    clearTimeout(waiting.watchdog);
    if (reply.status === "pull") {
      waiting.watchdog = this.#watch(port, waiting.deadlineMs);
      this.#answerPull(port, waiting.tables, reply);
      return;
    }
    this.#waiting.delete(reply.requestId);
    this.#lastUseMs = performance.now();
    if (reply.status === "failed") {
      waiting.reject(new Error(`The markdown worker failed: ${reply.reason}`));
    } else {
      waiting.resolve(reply);
    }
  }

  /**
   * Answers `pull` in a task of its own with as many of the rows it asks for as one slice writes,
   * from the table `tables` holds under its key. Fails `port` for an ask no held table answers.
   */
  #answerPull(
    port: MarkdownWorkerPort,
    tables: ReadonlyMap<string, Table>,
    pull: Extract<MarkdownWorkerReply, { status: "pull" }>,
  ): void {
    const table = tables.get(pull.tableKey);
    if (
      table === undefined ||
      !Number.isInteger(pull.firstIndex) ||
      !Number.isInteger(pull.lastIndex) ||
      pull.firstIndex < 0 ||
      pull.firstIndex > pull.lastIndex ||
      pull.lastIndex >= table.children.length - 1
    ) {
      this.#fail(port, "The markdown worker asked for rows no copied table holds");
      return;
    }
    // A table read in pieces answers from the piece holding the first row asked for, held while
    // its rows are written.
    const lastIndex = Math.min(
      pull.lastIndex,
      piecedRowsOf(table)?.pieceSpanOf(pull.firstIndex).lastIndex ?? pull.lastIndex,
    );
    let isHolding = true;
    let failure: string | undefined;
    const answer = (): void => {
      this.#view.scheduler
        .postTask(
          () => {
            if (port === this.#port && this.#waiting.has(pull.requestId)) {
              const rows = undrawnRowsJson(table, pull.firstIndex, lastIndex);
              port.postMessage({ kind: "undrawn-rows", requestId: pull.requestId, rows });
            }
          },
          { priority: "user-visible" },
        )
        .catch((error: unknown) => {
          this.#fail(
            port,
            `The page could not answer the markdown worker: ${describeFailure(error)}`,
          );
        })
        .finally(() => {
          letGo();
        });
    };
    // Rows already read answer within the call; the hold is let go only after it returns.
    const letGo = holdTableRows(table, pull.firstIndex, lastIndex, (readFailure) => {
      if (readFailure === undefined) {
        answer();
      } else if (isHolding) {
        failure = readFailure;
      } else {
        this.#failPull(port, readFailure, letGo);
      }
    });
    isHolding = false;
    if (failure !== undefined) {
      this.#failPull(port, failure, letGo);
    }
  }

  #failPull(port: MarkdownWorkerPort, failure: string, letGo: Unsubscribe): void {
    letGo();
    this.#fail(port, `The page could not read the rows the markdown worker asked for: ${failure}`);
  }

  #armParseWatchdog(port: MarkdownWorkerPort): void {
    clearTimeout(this.#parseWatchdog);
    this.#parseWatchdog = this.#watch(port, PARSE_ANSWER_DEADLINE_MS);
  }

  /**
   * At the idle stop, end `port` if nothing used it, held it or waits on it, else look again when
   * the idle stop would next run out. One timer per idle stop, never one per use.
   */
  #armIdleCheck(port: MarkdownWorkerPort, delayMs: number): void {
    this.#idleCheck = setTimeout(() => {
      if (this.#holdCount > 0 || this.#waiting.size > 0 || this.#waitingWorkCount > 0) {
        this.#armIdleCheck(port, MARKDOWN_WORKER_IDLE_STOP_MS);
        return;
      }
      const idleMs = performance.now() - this.#lastUseMs;
      if (idleMs < MARKDOWN_WORKER_IDLE_STOP_MS) {
        this.#armIdleCheck(port, MARKDOWN_WORKER_IDLE_STOP_MS - idleMs);
        return;
      }
      this.#end(port);
    }, delayMs);
  }

  /** End `port` and fail every request it holds; the next request starts a new worker. */
  #fail(port: MarkdownWorkerPort, reason: string): void {
    if (port !== this.#port) {
      return;
    }
    this.#end(port);
    const waiting = [...this.#waiting.values()];
    this.#waiting.clear();
    const waitingParses = [...this.#waitingParses.values()];
    this.#waitingParses.clear();
    const waitingCuts = [...this.#waitingCuts.values()];
    this.#waitingCuts.clear();
    for (const request of waiting) {
      clearTimeout(request.watchdog);
      request.reject(new Error(reason));
    }
    for (const settle of waitingParses) {
      settle({ status: "failed", reason });
    }
    for (const settle of waitingCuts) {
      settle({ status: "failed", reason });
    }
  }

  /** End `port` and its timers; the next request or wake starts a new worker. */
  #end(port: MarkdownWorkerPort): void {
    port.terminate();
    clearTimeout(this.#parseWatchdog);
    clearTimeout(this.#idleCheck);
    this.#port = undefined;
  }
}

/**
 * What the drawn part `tree` copies as in `flavor`: read at once on the page's thread when it holds
 * fewer characters than `PAGE_DRAWN_TEXT_CHARACTER_LIMIT` and no long table's undrawn rows, whose
 * writing grows with the table, otherwise by `worker` off it, its undrawn rows read from `tables`,
 * rejecting as its `drawnText` does.
 */
export function makeDrawnText(
  tree: DrawnTree,
  flavor: CopyFlavor,
  tables: ReadonlyMap<string, Table>,
  worker: Pick<MarkdownWorkerConnection, "drawnText">,
): DrawnPartCopy | Promise<DrawnPartCopy> {
  if (tables.size > 0 || drawnTreeLength(tree) >= PAGE_DRAWN_TEXT_CHARACTER_LIMIT) {
    return worker.drawnText(tree, flavor, tables);
  }
  const text = drawnTreeText(tree, flavor);
  return { text: { text, pieces: [text] } };
}

/** The app's markdown worker, loaded from the renderer's own origin as a module. */
export function startMarkdownWorker(): MarkdownWorkerPort {
  return new Worker(new URL("./entry.ts", import.meta.url), { type: "module", name: "markdown" });
}

/** A tree the worker answered, and the parse it answers. */
interface HandedTree {
  readonly settle: (answer: MarkdownParseAnswer) => void;
  readonly answer: MarkdownParseAnswer;
}

/**
 * One request to make a copy sent and not answered: how to settle it, the deadline that fails its
 * worker, and the tables its asks for rows are answered from.
 */
interface WaitingText {
  readonly resolve: (made: MarkdownWorkerMade) => void;
  readonly reject: (error: Error) => void;
  watchdog: ReturnType<typeof setTimeout>;
  readonly deadlineMs: number;
  readonly tables: ReadonlyMap<string, Table>;
}

/**
 * How long the worker may leave a text to parse or cut unanswered, in milliseconds, counted from
 * the first text it holds and again from each answer. The app's first worker had the parser
 * compiled and loaded about 170 ms after its fetch began on a launching machine, a later one loads
 * it from the kept module in about 15 ms, a 256 KB text parses in under 10 ms and an 8 MiB reply
 * cuts in under 300 ms, so this leaves a heavily loaded machine plenty of room while a parser that
 * never answers still fails its texts.
 */
const PARSE_ANSWER_DEADLINE_MS = 10_000;

/**
 * How long the worker may take over a request to make a copy, in milliseconds, for each started
 * mebibyte of it, counted from when it is sent, including a worker's start, and again from each ask
 * for rows. A 2 MiB reply took about 1.1 s to make into HTML on the page's own thread, so this
 * leaves a heavily loaded machine room while a worker that never answers still fails it.
 */
const ANSWER_DEADLINE_MS_PER_MEBIBYTE = 10_000;

/**
 * Body rows of `table` from `firstIndex` toward `lastIndex`, each as its JSON, as many as one slice
 * writes and at least one: written a row at a time, so the slice ends by the clock, where the
 * structured clone of a message of rows would run to the last row however long it took. Each
 * node's place in the source is left out: the worker reads none of them, and measured, they made
 * a bench row's JSON 2,300 characters rather than 550, and its sending three times as long.
 */
function undrawnRowsJson(table: Table, firstIndex: number, lastIndex: number): string[] {
  const hasTime = startSlice();
  const rows: string[] = [];
  passTableRows(table, firstIndex, lastIndex, (row) => {
    rows.push(JSON.stringify(row, withoutPosition));
    return hasTime();
  });
  return rows;
}

/** A JSON replacer leaving out each node's `position`. */
function withoutPosition(key: string, value: unknown): unknown {
  return key === "position" ? undefined : value;
}

/** The deadline of a request `byteLength` bytes long. */
function answerDeadlineMs(byteLength: number): number {
  return ANSWER_DEADLINE_MS_PER_MEBIBYTE * Math.max(1, Math.ceil(byteLength / 2 ** 20));
}

/**
 * The app's one connection to the markdown worker. Every window is drawn from the one console
 * document, so every window's requests reach the same worker.
 */
export const markdownWorker: MarkdownWorkerConnection = new MarkdownWorkerConnection(
  startMarkdownWorker,
  window,
  appPageParser,
  appTextCompression,
);
