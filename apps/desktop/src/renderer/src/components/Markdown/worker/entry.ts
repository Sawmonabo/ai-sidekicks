// The markdown worker: loads the parser, compiling it from the renderer's own origin when the page
// hands it none and sending the compiled module back for later workers, and then, off the page's
// thread, parses each text the page sends into the parser's binary tree, cuts each body's text the
// page sends into blocks, makes each reply's markdown into HTML under the screen's policy, and
// reads each drawn part back into the text it copies as, with its HTML when it is copied as
// markdown, asking the page for a long table's undrawn rows as it reads them. The trees, and the
// cuts, of texts that arrive together are sent together, so the page lands a screen of them in one
// pass. When the parser fails to load, or fails on a text, the reply says so and the page ends this
// worker; a text it cannot make into a copy is answered with the reason, and the worker goes on with
// the rest.

import parserModuleUrl from "@bruits/satteri-wasm32-wasi/satteri_napi.wasm32-wasi.wasm?url";

import { describeFailure } from "#shared/failure-message.js";
import { BlockCut, MARKDOWN_SETTLE_LAG_BLOCKS } from "../parse/block-cut.js";
import { MarkdownWorkerAnswers, type MarkdownTreeParser } from "./answer.js";
import type {
  MarkdownBlockEnds,
  MarkdownCutRequest,
  MarkdownParserLoad,
  MarkdownWorkerMessage,
  MarkdownWorkerReply,
  SerializedMarkdownTree,
} from "./messages.js";

/** The parts of a dedicated worker's global scope this script uses; the DOM types lack them. */
interface MarkdownWorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<MarkdownWorkerMessage>) => void,
  ): void;
  postMessage(reply: MarkdownWorkerReply, transfer: readonly Transferable[]): void;
  /**
   * The compiled parser Sätteri's loader instantiates, patched to read it here instead of fetching
   * and compiling the parser itself; set before the loader is imported.
   */
  satteriWasmModule?: WebAssembly.Module;
}

/** The parser's calls, once the parser they run on is loaded. */
interface LoadedParser {
  readonly serializer: typeof import("../parse/serialized-tree.js");
  readonly children: typeof import("../parse/top-level-children.js");
}

// The script runs only as a dedicated worker, whose global scope is this shape.
const workerScope = globalThis as unknown as MarkdownWorkerScope;

/**
 * The most bytes of answers the worker holds before it sends them: a long table parsed in many
 * pieces sends them as they are made, so the worker never holds the whole table's trees.
 */
const UNSENT_ANSWER_BYTE_CAP = 8 * 2 ** 20;

/**
 * The answers of one kind made since the last send, sent together once the requests that arrived
 * with them are done, so the page lands them in one pass.
 */
class AnswerOutbox<Answer> {
  readonly #send: (answers: Answer[]) => void;
  readonly #byteLengthOf: (answer: Answer) => number;
  #unsent: Answer[] = [];
  #unsentByteLength = 0;

  public constructor(send: (answers: Answer[]) => void, byteLengthOf: (answer: Answer) => number) {
    this.#send = send;
    this.#byteLengthOf = byteLengthOf;
  }

  public add(answer: Answer): void {
    this.#unsent.push(answer);
    this.#unsentByteLength += this.#byteLengthOf(answer);
    if (this.#unsentByteLength >= UNSENT_ANSWER_BYTE_CAP) {
      this.#sendUnsent();
    } else if (this.#unsent.length === 1) {
      // A zero delay runs after the requests already waiting in this worker's queue.
      setTimeout(() => {
        this.#sendUnsent();
      }, 0);
    }
  }

  #sendUnsent(): void {
    const answers = this.#unsent;
    if (answers.length === 0) {
      return;
    }
    this.#unsent = [];
    this.#unsentByteLength = 0;
    this.#send(answers);
  }
}

/** Loads the parser the page hands over, or compiles it, and warms it on a short reply. */
async function loadParser(load: MarkdownParserLoad): Promise<LoadedParser> {
  let parser = load.parser;
  if (parser === undefined) {
    parser = await WebAssembly.compileStreaming(fetch(parserModuleUrl));
    workerScope.postMessage({ status: "compiled", parser }, []);
  }
  workerScope.satteriWasmModule = parser;
  const [serializer, children] = await Promise.all([
    import("../parse/serialized-tree.js"),
    import("../parse/top-level-children.js"),
  ]);
  serializer.warmUpMarkdownParser();
  return { serializer, children };
}

/**
 * Where the blocks of the text `request` holds end, cut a window at a time. The parser frees what a
 * window's parse held from finalizers, which run only once the worker's event loop turns, so it
 * turns between windows.
 */
async function cutInTurns(request: MarkdownCutRequest, parser: LoadedParser): Promise<Uint32Array> {
  const cut = new BlockCut(
    request.source,
    request.isFinal,
    MARKDOWN_SETTLE_LAG_BLOCKS,
    parser.children.readTopLevelChildren,
  );
  while (!cut.cutWindow()) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  return cut.blockEnds;
}

// Listening from the start, so a text sent before the parser arrives waits for it here. A failed
// load is said once, here; the page then ends this worker, so nothing waiting is answered.
const parserLoad = new Promise<LoadedParser | undefined>((resolve) => {
  workerScope.addEventListener("message", (event) => {
    if (event.data.kind !== "load") {
      return;
    }
    resolve(
      loadParser(event.data).catch((error: unknown) => {
        workerScope.postMessage({ status: "load-failed", reason: describeFailure(error) }, []);
        return undefined;
      }),
    );
  });
});

const treeOutbox = new AnswerOutbox<SerializedMarkdownTree>(
  (trees) => {
    workerScope.postMessage(
      { status: "parsed", trees },
      trees.map((tree) => tree.buffer),
    );
  },
  (tree) => tree.buffer.byteLength,
);

const cutOutbox = new AnswerOutbox<MarkdownBlockEnds>(
  (cuts) => {
    workerScope.postMessage(
      { status: "cut", cuts },
      cuts.map((cut) => cut.blockEnds.buffer),
    );
  },
  (cut) => cut.blockEnds.byteLength,
);

const answers = new MarkdownWorkerAnswers(
  (reply, transfer) => {
    workerScope.postMessage(reply, transfer);
  },
  parserLoad.then((parser): MarkdownTreeParser | undefined => parser?.serializer.parseMarkdownTree),
);

workerScope.addEventListener("message", (event) => {
  const message = event.data;
  if (message.kind === "load") {
    return;
  }
  if (message.kind === "cut") {
    void parserLoad.then(async (parser) => {
      if (parser === undefined) {
        return;
      }
      try {
        cutOutbox.add({
          requestId: message.requestId,
          blockEnds: await cutInTurns(message, parser),
        });
      } catch (error: unknown) {
        workerScope.postMessage({ status: "parser-failed", reason: describeFailure(error) }, []);
      }
    });
    return;
  }
  if (message.kind !== "parse") {
    answers.hear(message);
    return;
  }
  void parserLoad.then((parser) => {
    if (parser === undefined) {
      return;
    }
    try {
      const { buffer, dollarStandIn } = parser.serializer.serializeMarkdownTree(message.source);
      treeOutbox.add({ requestId: message.requestId, buffer, dollarStandIn });
    } catch (error: unknown) {
      workerScope.postMessage({ status: "parser-failed", reason: describeFailure(error) }, []);
    }
  });
});
