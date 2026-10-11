// The page's end of the markdown worker, one for the whole app. It starts the worker on the first
// request, sends a reply's markdown as the UTF-8 bytes of its pieces, moved to the worker, or a
// drawn part's tree as a copy, answers each of the worker's asks for a long table's undrawn rows
// from the table the page drew, and pairs what the worker made with its request. The pieces are
// encoded and decoded a few a slice, and each ask is answered with the rows one slice writes, so
// no task on the page grows with a text or a table. When the worker stops, sends a reply that
// cannot be read or an ask no copied table answers, or leaves a request unanswered past its
// deadline, it ends that worker and fails every request still waiting; the next request starts a
// new one. A worker left with nothing to do for a minute is ended to give its memory back.

import type { Table } from "mdast";

import type { WorkerPort, WorkerStart } from "#renderer/lib/worker-port.js";
import { startSlice } from "#renderer/lib/work-slices.js";
import { describeFailure } from "#shared/failure-message.js";
import {
  decodePiecesInSlices,
  encodePiecesInSlices,
  piecesOf,
  type PiecedText,
} from "#renderer/lib/text-pieces.js";
import { drawnTreeLength, drawnTreeText, type CopyFlavor, type DrawnTree } from "../drawn-text.js";
import { markdownToHtml } from "../html.js";
import type {
  MarkdownWorkerMade,
  MarkdownWorkerMessage,
  MarkdownWorkerReply,
  MarkdownWorkerRequest,
} from "./messages.js";

/** What a drawn part copies as: its text, and its HTML when the worker made it with the text. */
export interface DrawnPartCopy {
  readonly text: PiecedText;
  readonly html?: string;
}

/** The markdown worker as the connection drives it, so a test can stand in for the worker. */
export type MarkdownWorkerPort = WorkerPort<MarkdownWorkerMessage, MarkdownWorkerReply>;

/** Starts one markdown worker. */
export type MarkdownWorkerStart = WorkerStart<MarkdownWorkerMessage, MarkdownWorkerReply>;

/**
 * The length, in UTF-16 code units, from which a text is made into HTML by the worker rather
 * than on the page's thread. Measured on a loaded machine, the page made HTML at about 0.75 ms a
 * KiB and a warm worker's round trip took 0.3 to 0.7 ms longer: a 4 KiB text took 3.2 ms on the
 * page, which still fits a 4 ms slice of copy work inside a frame, and 6 ms at 8 KiB, which does
 * not.
 */
export const PAGE_HTML_CHARACTER_LIMIT = 4096;

/**
 * The characters a drawn part holds, as `drawnTreeLength` counts them, from which the worker reads
 * it into its text rather than the page. Measured on a loaded machine, a table of 1 KiB took 3.4 ms
 * to rebuild as markdown on the page, which fits a 4 ms slice of copy work inside a frame, and
 * 6.1 ms at 2 KiB, which does not; prose and plain text cost less.
 */
export const PAGE_DRAWN_TEXT_CHARACTER_LIMIT = 1024;

/** One worker at a time: started on the first request, replaced after it fails, ended when idle. */
export class MarkdownWorkerConnection {
  readonly #startWorker: MarkdownWorkerStart;
  readonly #view: Window;
  /** Each request sent and not answered, by its id. */
  readonly #waiting = new Map<number, WaitingText>();
  #port: MarkdownWorkerPort | undefined;
  /** Ends the current worker once it has had nothing to do for the idle stop. */
  #idleStop: ReturnType<typeof setTimeout> | undefined;
  #requestCount = 0;

  /** `view` is the window whose thread encodes and decodes the texts, a slice at a time. */
  public constructor(startWorker: MarkdownWorkerStart, view: Window) {
    this.#startWorker = startWorker;
    this.#view = view;
  }

  /**
   * The HTML `markdown` makes under the screen's policy, made off the page's thread from `pieces`,
   * the same text in pieces: the same bytes `markdownToHtml` makes on it. Rejects with an `Error`
   * when the worker cannot start, cannot make the HTML, stops, or does not answer in time.
   */
  public async html(
    markdown: string,
    pieces: readonly string[] = piecesOf(markdown),
  ): Promise<string> {
    const encoded = await encodePiecesInSlices(pieces, this.#view);
    const made = await this.#ask(
      (requestId) => ({ kind: "html", requestId, markdown: encoded }),
      encoded,
      markdown.length,
    );
    return (await decodePiecesInSlices(made.text, this.#view)).text;
  }

  /**
   * What the drawn part `tree` copies as in `flavor`, read off the page's thread: the same text
   * `drawnTreeText` or `drawnTreeMarkdown` reads on it, with the HTML of a part copied as markdown,
   * each of its long tables' undrawn rows read from the table `tables` holds under the key the rows
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
      : { text, html: (await decodePiecesInSlices(made.html, this.#view)).text };
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
    let port: MarkdownWorkerPort;
    try {
      port = this.#port ?? this.#open();
    } catch (error: unknown) {
      return Promise.reject(
        new Error(`The markdown worker could not start: ${describeFailure(error)}`),
      );
    }
    clearTimeout(this.#idleStop);
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
    return port;
  }

  #hear(port: MarkdownWorkerPort, reply: MarkdownWorkerReply): void {
    const waiting = this.#waiting.get(reply.requestId);
    if (port !== this.#port || waiting === undefined) {
      return;
    }
    clearTimeout(waiting.watchdog);
    if (reply.status === "pull") {
      waiting.watchdog = this.#watch(port, waiting.deadlineMs);
      this.#answerPull(port, waiting.tables, reply);
      return;
    }
    this.#waiting.delete(reply.requestId);
    if (reply.status === "failed") {
      waiting.reject(new Error(`The markdown worker failed: ${reply.reason}`));
    } else {
      waiting.resolve(reply);
    }
    if (this.#waiting.size === 0) {
      this.#idleStop = setTimeout(() => {
        if (port === this.#port) {
          this.#end(port);
        }
      }, MARKDOWN_WORKER_IDLE_STOP_MS);
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
    this.#view.scheduler
      .postTask(
        () => {
          if (port === this.#port && this.#waiting.has(pull.requestId)) {
            const rows = undrawnRowsJson(table, pull.firstIndex, pull.lastIndex);
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
      });
  }

  /** End `port` and fail every request it holds; the next request starts a new worker. */
  #fail(port: MarkdownWorkerPort, reason: string): void {
    if (port !== this.#port) {
      return;
    }
    this.#end(port);
    const waiting = [...this.#waiting.values()];
    this.#waiting.clear();
    for (const request of waiting) {
      clearTimeout(request.watchdog);
      request.reject(new Error(reason));
    }
  }

  #end(port: MarkdownWorkerPort): void {
    port.terminate();
    clearTimeout(this.#idleStop);
    this.#port = undefined;
  }
}

/**
 * One request sent and not answered: how to settle it, the deadline that fails its worker, and the
 * tables its asks for rows are answered from.
 */
interface WaitingText {
  readonly resolve: (made: MarkdownWorkerMade) => void;
  readonly reject: (error: Error) => void;
  watchdog: ReturnType<typeof setTimeout>;
  readonly deadlineMs: number;
  readonly tables: ReadonlyMap<string, Table>;
}

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
  let index = firstIndex;
  do {
    rows.push(JSON.stringify(table.children[index + 1], withoutPosition));
    index += 1;
  } while (index <= lastIndex && hasTime());
  return rows;
}

/** A JSON replacer leaving out each node's `position`. */
function withoutPosition(key: string, value: unknown): unknown {
  return key === "position" ? undefined : value;
}

/**
 * How long the worker may take over a request, in milliseconds, for each started mebibyte of it,
 * counted from when it is sent, including a worker's start, and again from each ask for rows. A
 * 2 MiB reply took about 1.1 s to make into HTML on the page's own thread, so this leaves a heavily
 * loaded machine room while a worker that never answers still fails it.
 */
const ANSWER_DEADLINE_MS_PER_MEBIBYTE = 10_000;

/**
 * How long the worker may sit with nothing to do, in milliseconds, before it is ended to give its
 * memory back; the next request starts a new one.
 */
const MARKDOWN_WORKER_IDLE_STOP_MS = 60_000;

/**
 * The HTML `markdown` makes under the screen's policy: made at once on the page's thread when it is
 * shorter than `PAGE_HTML_CHARACTER_LIMIT`, otherwise by `worker` off it from `pieces`, the same
 * text in pieces when it is held so, rejecting as its `html` does.
 */
export function makeMarkdownHtml(
  markdown: string,
  worker: Pick<MarkdownWorkerConnection, "html">,
  pieces?: readonly string[],
): string | Promise<string> {
  return markdown.length < PAGE_HTML_CHARACTER_LIMIT
    ? markdownToHtml(markdown)
    : worker.html(markdown, pieces);
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

/** The deadline of a request `byteLength` bytes long. */
function answerDeadlineMs(byteLength: number): number {
  return ANSWER_DEADLINE_MS_PER_MEBIBYTE * Math.max(1, Math.ceil(byteLength / 2 ** 20));
}

/**
 * The app's one connection to the markdown worker. Every window is drawn from the one console
 * document, so every window's requests reach the same worker; it starts on the first one.
 */
export const markdownWorker: MarkdownWorkerConnection = new MarkdownWorkerConnection(
  startMarkdownWorker,
  window,
);
