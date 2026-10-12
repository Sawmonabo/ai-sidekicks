// The markdown parser on the page's own thread, so a block is parsed the frame it mounts and no
// tree is kept for a block that is not. The page never compiles WebAssembly: it runs the module the
// markdown worker compiled and posted, which the worker's connection hands here at an idle moment.
// Sätteri's loader reads that module off the global it sets, as the worker's own loader does, and
// the loader and the parser arrive on a chunk of their own the first time the page parser starts,
// never with the window's start. Starting takes one task of some 20 ms, its warm-up parse included.

import type { Root } from "mdast";

import { recordRejectedRequest } from "#renderer/lib/diagnostic-capture/rejected-request-record.js";
import { Emitter } from "#renderer/lib/emitter.js";
import type { Unsubscribe } from "#shared/preload-api.js";

/**
 * Where the page parser stands: not handed a module yet, loading one, ready to parse, or failed to
 * start, or told the worker failed to load the module before the page was handed one.
 */
export type PageParserState = "idle" | "loading" | "ready" | "failed";

/** The parse module the page parser runs, once loaded. */
export type MarkdownSerializer = typeof import("./serialized-tree.js");

/**
 * One page parser: started once from the worker's compiled module, then parsing synchronously.
 * `loadSerializer` imports the parse module, after the module is set on the global its loader reads.
 */
export class PageParser {
  readonly #loadSerializer: () => Promise<MarkdownSerializer>;
  readonly #changes = new Emitter<void>("page parser state");
  #state: PageParserState = "idle";
  #serializer: MarkdownSerializer | undefined;

  public constructor(loadSerializer: () => Promise<MarkdownSerializer>) {
    this.#loadSerializer = loadSerializer;
  }

  /** Where the page parser stands now. */
  public get state(): PageParserState {
    return this.#state;
  }

  /** Hears each change of `state`. */
  public subscribe(listener: () => void): Unsubscribe {
    return this.#changes.subscribe(listener);
  }

  /**
   * Starts the parser from the module the markdown worker compiled, and warms it up. Does nothing
   * while it loads or once it is ready; from `failed` it tries again, as a worker that compiled
   * the module again hands it over again. A start that fails is recorded and leaves it `failed`.
   */
  public start(module: WebAssembly.Module): void {
    if (this.#state === "loading" || this.#state === "ready") {
      return;
    }
    this.#setState("loading");
    (globalThis as SatteriLoaderScope).satteriWasmModule = module;
    void this.#loadSerializer()
      .then((serializer) => {
        serializer.warmUpMarkdownParser();
        return serializer;
      })
      .then(
        (serializer) => {
          this.#serializer = serializer;
          this.#setState("ready");
        },
        (error: unknown) => {
          recordRejectedRequest("components/Markdown/parse", "page-parser-not-started", error);
          this.#setState("failed");
        },
      );
  }

  /**
   * Fails a parser not yet handed a module, as the worker failed to load one before the page got
   * it; a parser handed one keeps its own instance, whatever a worker does after.
   */
  public fail(): void {
    if (this.#state === "idle") {
      this.#setState("failed");
    }
  }

  /**
   * `source` parsed into the tree the screen draws, synchronously. Throws when the parser is not
   * `ready`, or when the parser breaks on the text.
   */
  public parse(source: string): Root {
    const serializer = this.#serializer;
    if (serializer === undefined) {
      throw new Error(`The page's markdown parser is ${this.#state}, not ready`);
    }
    return serializer.parseMarkdownTree(source);
  }

  #setState(state: PageParserState): void {
    this.#state = state;
    this.#changes.emit();
  }
}

/** The global Sätteri's loader reads the compiled parser from, as it imports. */
interface SatteriLoaderScope {
  satteriWasmModule?: WebAssembly.Module;
}

/** The app's page parser, which the markdown worker's connection starts. */
export const appPageParser: PageParser = new PageParser(
  async () => await import("./serialized-tree.js"),
);
