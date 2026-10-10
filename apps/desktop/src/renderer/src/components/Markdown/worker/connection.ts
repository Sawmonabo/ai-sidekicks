// The page's end of the markdown worker, one for the whole app. It starts the worker on the first
// text, sends each text as UTF-8 bytes moved to the worker, and pairs each HTML reply with its
// text. When the worker stops, sends a reply that cannot be read, or leaves a text unanswered past
// its deadline, it ends that worker and fails every text still waiting; the next text starts a new
// one. A worker left with nothing to do for a minute is ended to give its memory back.

import type { WorkerPort, WorkerStart } from "#renderer/lib/worker-port.js";
import { describeFailure } from "#shared/failure-message.js";
import { markdownToHtml } from "../html.js";
import type { MarkdownWorkerReply, MarkdownWorkerRequest } from "./messages.js";

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

/** One worker at a time: started on the first text, replaced after it fails, ended when idle. */
export class MarkdownWorkerConnection {
  readonly #startWorker: MarkdownWorkerStart;
  /** Each text sent and not answered, by its request id. */
  readonly #waiting = new Map<number, WaitingText>();
  #port: MarkdownWorkerPort | undefined;
  /** Ends the current worker once it has had nothing to do for the idle stop. */
  #idleStop: ReturnType<typeof setTimeout> | undefined;
  #requestCount = 0;

  public constructor(startWorker: MarkdownWorkerStart) {
    this.#startWorker = startWorker;
  }

  /**
   * The HTML `markdown` makes under the screen's policy, made off the page's thread: the same bytes
   * `markdownToHtml` makes on it. Rejects with an `Error` when the worker cannot start, cannot make
   * the HTML, stops, or does not answer in time.
   */
  public html(markdown: string): Promise<string> {
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
    const source = new TextEncoder().encode(markdown).buffer;
    return new Promise((resolve, reject) => {
      const watchdog = setTimeout(() => {
        this.#fail(port, "The markdown worker did not answer in time");
      }, answerDeadlineMs(source.byteLength));
      this.#waiting.set(requestId, { resolve, reject, watchdog });
      port.postMessage({ kind: "html", requestId, source }, [source]);
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
      waiting.resolve(new TextDecoder().decode(reply.html));
    }
    if (this.#waiting.size === 0) {
      this.#idleStop = setTimeout(() => {
        if (port === this.#port) {
          this.#end(port);
        }
      }, MARKDOWN_WORKER_IDLE_STOP_MS);
    }
  }

  /** End `port` and fail every text it holds; the next text starts a new worker. */
  #fail(port: MarkdownWorkerPort, reason: string): void {
    if (port !== this.#port) {
      return;
    }
    this.#end(port);
    const waiting = [...this.#waiting.values()];
    this.#waiting.clear();
    for (const text of waiting) {
      clearTimeout(text.watchdog);
      text.reject(new Error(reason));
    }
  }

  #end(port: MarkdownWorkerPort): void {
    port.terminate();
    clearTimeout(this.#idleStop);
    this.#port = undefined;
  }
}

/** One text sent and not answered: how to settle it, and the deadline that fails its worker. */
interface WaitingText {
  readonly resolve: (html: string) => void;
  readonly reject: (error: Error) => void;
  readonly watchdog: ReturnType<typeof setTimeout>;
}

/**
 * How long the worker may take over a text, in milliseconds, for each started mebibyte of it,
 * counted from when the text is sent and including a worker's start. A 2 MiB reply took about
 * 1.1 s on the page's own thread, so this leaves a heavily loaded machine plenty of room while a
 * worker that never answers still fails its text.
 */
const ANSWER_DEADLINE_MS_PER_MEBIBYTE = 10_000;

/**
 * How long the worker may sit with nothing to do, in milliseconds, before it is ended to give its
 * memory back; the next text starts a new one.
 */
const MARKDOWN_WORKER_IDLE_STOP_MS = 60_000;

/**
 * The HTML `markdown` makes under the screen's policy: made at once on the page's thread when it is
 * shorter than `PAGE_HTML_CHARACTER_LIMIT`, otherwise by `worker` off it, rejecting as its `html`
 * does.
 */
export function makeMarkdownHtml(
  markdown: string,
  worker: Pick<MarkdownWorkerConnection, "html">,
): string | Promise<string> {
  return markdown.length < PAGE_HTML_CHARACTER_LIMIT
    ? markdownToHtml(markdown)
    : worker.html(markdown);
}

/** The app's markdown worker, loaded from the renderer's own origin as a module. */
export function startMarkdownWorker(): MarkdownWorkerPort {
  return new Worker(new URL("./entry.ts", import.meta.url), { type: "module", name: "markdown" });
}

/** The deadline of a text `byteLength` bytes long. */
function answerDeadlineMs(byteLength: number): number {
  return ANSWER_DEADLINE_MS_PER_MEBIBYTE * Math.max(1, Math.ceil(byteLength / 2 ** 20));
}

/**
 * The app's one connection to the markdown worker. Every window is drawn from the one console
 * document, so every window's text reaches the same worker; it starts on the first text.
 */
export const markdownWorker: MarkdownWorkerConnection = new MarkdownWorkerConnection(
  startMarkdownWorker,
);
