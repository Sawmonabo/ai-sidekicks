// The page's end of the markdown worker, one for the whole app. It starts the worker on the first
// request, sends a reply's markdown or a long table block's text as the UTF-8 bytes of its pieces,
// moved to the worker, or a drawn part's tree as a copy, and pairs each text the worker made with
// its request. The pieces are encoded and decoded a few a slice, so no task on the page grows with
// a text. When the worker stops, sends a reply that cannot be read, or leaves a request unanswered
// past its deadline, it ends that worker and fails every request still waiting; the next request
// starts a new one. A worker left with nothing to do for a minute is ended to give its memory back.

import type { WorkerPort, WorkerStart } from "#renderer/lib/worker-port.js";
import { describeFailure } from "#shared/failure-message.js";
import {
  decodePiecesInSlices,
  encodePiecesInSlices,
  piecesOf,
  type PiecedText,
} from "#renderer/lib/text-pieces.js";
import { drawnTreeLength, drawnTreeText, type CopyFlavor, type DrawnTree } from "../drawn-text.js";
import { markdownToHtml } from "../html.js";
import { type BlockParseSource } from "../parse.js";
import type {
  BlockParseSourceMessage,
  MarkdownWorkerReply,
  MarkdownWorkerRequest,
} from "./messages.js";

/** The markdown worker as the connection drives it, so a test can stand in for the worker. */
export type MarkdownWorkerPort = WorkerPort<MarkdownWorkerRequest, MarkdownWorkerReply>;

/** Starts one markdown worker. */
export type MarkdownWorkerStart = WorkerStart<MarkdownWorkerRequest, MarkdownWorkerReply>;

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
    return (await decodePiecesInSlices(made, this.#view)).text;
  }

  /**
   * The text the drawn part `tree` copies as in `flavor`, read off the page's thread: the same text
   * `drawnTreeText` reads on it, each of its long tables' undrawn rows parsed from what
   * `blockSources` holds under the key the rows name. Rejects as `html` does.
   */
  public async drawnText(
    tree: DrawnTree,
    flavor: CopyFlavor,
    blockSources: ReadonlyMap<string, BlockParseSource>,
  ): Promise<PiecedText> {
    const sourceMessages = new Map<string, BlockParseSourceMessage>();
    let size = drawnTreeLength(tree);
    for (const [tableKey, blockSource] of blockSources) {
      const source = await encodePiecesInSlices(piecesOf(blockSource.source), this.#view);
      sourceMessages.set(tableKey, { ...blockSource, source });
      size += blockSource.source.length;
    }
    const made = await this.#ask(
      (requestId) => ({
        kind: "drawn-text",
        requestId,
        tree,
        flavor,
        blockSources: sourceMessages,
      }),
      [...sourceMessages.values()].flatMap((message) => message.source),
      size,
    );
    return await decodePiecesInSlices(made, this.#view);
  }

  /**
   * Sends the request `requestOf` makes, moving `transfer` to the worker, and resolves what it
   * made, within the deadline of a request `size` characters long.
   */
  #ask(
    requestOf: (requestId: number) => MarkdownWorkerRequest,
    transfer: readonly Transferable[],
    size: number,
  ): Promise<readonly ArrayBuffer[]> {
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
      const watchdog = setTimeout(() => {
        this.#fail(port, "The markdown worker did not answer in time");
      }, answerDeadlineMs(size));
      this.#waiting.set(requestId, { resolve, reject, watchdog });
      port.postMessage(requestOf(requestId), [...transfer]);
    });
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
    this.#waiting.delete(reply.requestId);
    clearTimeout(waiting.watchdog);
    if (reply.status === "failed") {
      waiting.reject(new Error(`The markdown worker failed: ${reply.reason}`));
    } else {
      waiting.resolve(reply.text);
    }
    if (this.#waiting.size === 0) {
      this.#idleStop = setTimeout(() => {
        if (port === this.#port) {
          this.#end(port);
        }
      }, MARKDOWN_WORKER_IDLE_STOP_MS);
    }
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

/** One request sent and not answered: how to settle it, and the deadline that fails its worker. */
interface WaitingText {
  readonly resolve: (made: readonly ArrayBuffer[]) => void;
  readonly reject: (error: Error) => void;
  readonly watchdog: ReturnType<typeof setTimeout>;
}

/**
 * How long the worker may take over a request, in milliseconds, for each started mebibyte of it,
 * counted from when it is sent and including a worker's start. A 2 MiB reply took about 1.1 s to
 * make into HTML on the page's own thread, and a 2 MiB table about 7 s to fill and rebuild, so
 * this leaves a heavily loaded machine room while a worker that never answers still fails it.
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
 * The text the drawn part `tree` copies as in `flavor`: read at once on the page's thread when it
 * holds fewer characters than `PAGE_DRAWN_TEXT_CHARACTER_LIMIT` and no long table's undrawn rows,
 * whose whole block would be parsed again, otherwise by `worker` off it from `blockSources`,
 * rejecting as its `drawnText` does.
 */
export function makeDrawnText(
  tree: DrawnTree,
  flavor: CopyFlavor,
  blockSources: ReadonlyMap<string, BlockParseSource>,
  worker: Pick<MarkdownWorkerConnection, "drawnText">,
): PiecedText | Promise<PiecedText> {
  if (blockSources.size > 0 || drawnTreeLength(tree) >= PAGE_DRAWN_TEXT_CHARACTER_LIMIT) {
    return worker.drawnText(tree, flavor, blockSources);
  }
  const text = drawnTreeText(tree, flavor, () => undefined);
  return { text, pieces: [text] };
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
