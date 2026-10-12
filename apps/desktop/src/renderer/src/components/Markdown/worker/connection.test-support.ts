// Stand-ins for the markdown worker, for suites that run where no worker can. Each answers on the
// test's own thread as the worker answers: a text to parse through the worker's own serializer,
// which Sätteri's Node build backs here, before `postMessage` returns unless a test holds those
// answers to release them in an order of its choosing; a text to cut through the worker's own cut,
// every window at once, before `postMessage` returns; and a copy to make a microtask later, each
// message copied and its buffers moved, as a message between threads is.

import { expect } from "vitest";

import { MarkdownWorkerAnswers } from "./answer.js";
import { MarkdownWorkerConnection, type MarkdownWorkerPort } from "./connection.js";
import type {
  CompiledTextCompression,
  MarkdownParseRequest,
  MarkdownWorkerMessage,
  MarkdownWorkerReply,
} from "./messages.js";
import { BlockCut, MARKDOWN_SETTLE_LAG_BLOCKS } from "../parse/block-cut.js";
import { appPageParser } from "../parse/page-parser.js";
import { parseMarkdownTree, serializeMarkdownTree } from "../parse/serialized-tree.js";
import { readTopLevelChildren } from "../parse/top-level-children.js";
import { appTextCompression } from "#renderer/lib/text/compression.js";

/** One stand-in worker: the texts it was sent to parse, and the answers a test holds back. */
export class InThreadMarkdownWorker implements MarkdownWorkerPort {
  public onmessage: ((event: MessageEvent<MarkdownWorkerReply>) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;
  public onmessageerror: ((event: MessageEvent) => void) | null = null;
  public readonly requests: MarkdownParseRequest[] = [];
  /** The parser each load handed it, `undefined` where it was asked to compile one. */
  public readonly loads: (WebAssembly.Module | undefined)[] = [];
  public isTerminated = false;
  /** The texts whose answers are held, oldest first, while the worker holds them. */
  #held: MarkdownParseRequest[] | undefined;
  readonly #answers = new MarkdownWorkerAnswers((reply, transfer) => {
    const received = structuredClone(reply, { transfer: [...transfer] });
    queueMicrotask(() => {
      this.#say(received);
    });
  }, Promise.resolve(parseMarkdownTree));

  public postMessage(message: MarkdownWorkerMessage, transfer: Transferable[] = []): void {
    // An ended worker drops what it is sent, as a real one does.
    if (this.isTerminated) {
      return;
    }
    if (message.kind === "load") {
      this.loads.push(message.parser);
      if (message.parser === undefined) {
        this.#say({
          status: "compiled",
          parser: inThreadParserModule(),
          textCompression: IN_THREAD_TEXT_COMPRESSION,
        });
      }
      return;
    }
    if (message.kind === "cut") {
      const cut = new BlockCut(
        message.source,
        message.isFinal,
        MARKDOWN_SETTLE_LAG_BLOCKS,
        readTopLevelChildren,
      );
      // Every window on this turn, so a suite reads the blocks before the ask returns.
      this.#say({
        status: "cut",
        cuts: [{ requestId: message.requestId, blockEnds: cut.cutWhole() }],
      });
      return;
    }
    if (message.kind !== "parse") {
      const received = structuredClone(message, { transfer });
      queueMicrotask(() => {
        this.#answers.hear(received);
      });
      return;
    }
    this.requests.push(message);
    if (this.#held !== undefined) {
      this.#held.push(message);
      return;
    }
    this.#answer(message);
  }

  public terminate(): void {
    this.isTerminated = true;
  }

  /** Hold every answer to a text to parse from now on until `release` sends them. */
  public hold(): void {
    this.#held = [];
  }

  /** Answer the held texts, by their place among them, in `order`, and stop holding. */
  public release(order: readonly number[]): void {
    const held = this.#held ?? expect.fail("the worker holds its answers");
    this.#held = undefined;
    for (const place of order) {
      this.#answer(held[place] ?? expect.fail(`a text is held at ${String(place)}`));
    }
  }

  /** Answer the held texts `isReleased` picks, oldest first, and keep holding the rest. */
  public releaseWhere(isReleased: (request: MarkdownParseRequest) => boolean): void {
    const held = this.#held ?? expect.fail("the worker holds its answers");
    const released = held.filter(isReleased);
    this.#held = held.filter((request) => !isReleased(request));
    for (const request of released) {
      this.#answer(request);
    }
  }

  /** Fail as the worker does when the parser it was handed or compiled does not load. */
  public failLoad(reason: string): void {
    this.#say({ status: "load-failed", reason });
  }

  /** Fail as the parser does when a text breaks it. */
  public failParser(reason: string): void {
    this.#say({ status: "parser-failed", reason });
  }

  #answer(request: MarkdownParseRequest): void {
    const { buffer, dollarStandIn } = serializeMarkdownTree(request.source);
    this.#say({
      status: "parsed",
      trees: [{ requestId: request.requestId, buffer, dollarStandIn }],
    });
  }

  #say(reply: MarkdownWorkerReply): void {
    if (!this.isTerminated) {
      this.onmessage?.(new MessageEvent("message", { data: reply }));
    }
  }
}

/** Starts stand-in workers and keeps each one it started, oldest first. */
export class InThreadMarkdownWorkers {
  public readonly started: InThreadMarkdownWorker[] = [];
  #isLoadingSlowly = false;

  /** Starts one stand-in, holding its answers when the workers load slowly. */
  public readonly start = (): InThreadMarkdownWorker => {
    const worker = new InThreadMarkdownWorker();
    if (this.#isLoadingSlowly) {
      worker.hold();
    }
    this.started.push(worker);
    return worker;
  };

  /**
   * Start every later worker holding its answers until `release`, as a real worker still loading
   * the parser keeps the texts sent to it in its message queue.
   */
  public loadSlowly(): void {
    this.#isLoadingSlowly = true;
  }

  /** The worker started last, which the next text is sent to. */
  public latest(): InThreadMarkdownWorker {
    return this.started.at(-1) ?? expect.fail("a worker was started");
  }
}

/**
 * A connection whose worker answers on the test's thread, its texts sliced in `view`, handing its
 * module to the app's page parser, which a suite starts before it runs.
 */
export function inThreadMarkdownWorker(view: Window): MarkdownWorkerConnection {
  return new MarkdownWorkerConnection(
    new InThreadMarkdownWorkers().start,
    view,
    appPageParser,
    appTextCompression,
  );
}

/**
 * The codec a stand-in worker hands the page: none, since the tier grants no idle moments to pack
 * in, so every packed text there stays plain.
 */
export const IN_THREAD_TEXT_COMPRESSION: CompiledTextCompression = {
  status: "absent",
  reason: "The in-thread markdown worker compiles no text codec",
};

/**
 * The module a stand-in worker compiles and hands the page: an empty one, which Sätteri's Node
 * build, which parses wherever no worker runs, never reads.
 */
export function inThreadParserModule(): WebAssembly.Module {
  return new WebAssembly.Module(EMPTY_WEBASSEMBLY_MODULE);
}

/** The smallest valid WebAssembly binary: its magic number and version, and no sections. */
const EMPTY_WEBASSEMBLY_MODULE = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
