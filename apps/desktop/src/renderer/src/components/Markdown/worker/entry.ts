// The markdown worker: loads the parser, compiling it from the renderer's own origin when the page
// hands it none and sending the compiled module back for later workers, and then, off the page's
// thread, parses each text the page sends into the parser's binary tree, makes each reply's
// markdown into HTML under the screen's policy, and reads each drawn part back into the text it
// copies as, with its HTML when it is copied as markdown, asking the page for a long table's
// undrawn rows as it reads them. The trees of texts that arrive together are sent together, so the
// page draws a screen of blocks in one pass. When the parser fails to load, or fails on a text, the
// reply says so and the page ends this worker; a text it cannot make into a copy is answered with
// the reason, and the worker goes on with the rest.

import parserModuleUrl from "@bruits/satteri-wasm32-wasi/satteri_napi.wasm32-wasi.wasm?url";

import { describeFailure } from "#shared/failure-message.js";
import { MarkdownWorkerAnswers, type MarkdownTreeParser } from "./answer.js";
import type {
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

/** The serializer, once the parser it runs on is loaded. */
type Serializer = typeof import("./serialized-tree.js");

// The script runs only as a dedicated worker, whose global scope is this shape.
const workerScope = globalThis as unknown as MarkdownWorkerScope;

/**
 * The most bytes of trees the worker holds before it sends them: a long table parsed in many
 * pieces sends them as they are made, so the worker never holds the whole table's trees.
 */
const UNSENT_TREE_BYTE_CAP = 8 * 2 ** 20;

/** The trees parsed since the last send, sent once the texts that arrived with them are done. */
class ParsedTreeOutbox {
  #unsent: SerializedMarkdownTree[] = [];
  #unsentByteLength = 0;

  public add(tree: SerializedMarkdownTree): void {
    this.#unsent.push(tree);
    this.#unsentByteLength += tree.buffer.byteLength;
    if (this.#unsentByteLength >= UNSENT_TREE_BYTE_CAP) {
      this.#send();
    } else if (this.#unsent.length === 1) {
      // A zero delay runs after the texts already waiting in this worker's queue.
      setTimeout(() => {
        this.#send();
      }, 0);
    }
  }

  #send(): void {
    const trees = this.#unsent;
    if (trees.length === 0) {
      return;
    }
    this.#unsent = [];
    this.#unsentByteLength = 0;
    workerScope.postMessage(
      { status: "parsed", trees },
      trees.map((tree) => tree.buffer),
    );
  }
}

/**
 * A short reply touching the paths replies take through the parser: headings, emphasis, a link, a
 * list, a task, a quote, a fence, a table, a formula and a footnote. WebAssembly compiles each
 * function the first time it runs, so parsing this once as the parser loads moves that compiling
 * off the first reply the person waits on; the compiled code belongs to the module the app keeps.
 */
const WARM_UP_TEXT = [
  "# Heading",
  "",
  "Prose with *emphasis*, **strong**, `code`, ~~struck~~, $x^2$, a [link](https://example.com)",
  "and a note.[^1] It costs $5 and $10.",
  "",
  "- [x] A task",
  "- An item",
  "  1. Nested",
  "",
  "> A quote",
  "",
  "```ts",
  "const answer = 42;",
  "```",
  "",
  "| Lane | Rows |",
  "| --- | ---: |",
  "| Architect | 412 |",
  "",
  "[^1]: The note.",
  "",
].join("\n");

/** Loads the parser the page hands over, or compiles it, and warms it on a short reply. */
async function loadParser(load: MarkdownParserLoad): Promise<Serializer> {
  let parser = load.parser;
  if (parser === undefined) {
    parser = await WebAssembly.compileStreaming(fetch(parserModuleUrl));
    workerScope.postMessage({ status: "compiled", parser }, []);
  }
  workerScope.satteriWasmModule = parser;
  const serializer = await import("./serialized-tree.js");
  serializer.serializeMarkdownTree(WARM_UP_TEXT);
  return serializer;
}

// Listening from the start, so a text sent before the parser arrives waits for it here. A failed
// load is said once, here; the page then ends this worker, so nothing waiting is answered.
const serializerLoad = new Promise<Serializer | undefined>((resolve) => {
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

const outbox = new ParsedTreeOutbox();

const answers = new MarkdownWorkerAnswers(
  (reply, transfer) => {
    workerScope.postMessage(reply, transfer);
  },
  serializerLoad.then(
    (serializer): MarkdownTreeParser | undefined => serializer?.parseMarkdownTree,
  ),
);

workerScope.addEventListener("message", (event) => {
  const message = event.data;
  if (message.kind === "load") {
    return;
  }
  if (message.kind !== "parse") {
    answers.hear(message);
    return;
  }
  void serializerLoad.then((serializer) => {
    if (serializer === undefined) {
      return;
    }
    try {
      const { buffer, dollarStandIn } = serializer.serializeMarkdownTree(message.source);
      outbox.add({ requestId: message.requestId, buffer, dollarStandIn });
    } catch (error: unknown) {
      workerScope.postMessage({ status: "parser-failed", reason: describeFailure(error) }, []);
    }
  });
});
