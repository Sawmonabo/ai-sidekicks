// The markdown parser on the page's own thread, so a block is parsed the frame it mounts and no
// tree is kept for a block that is not. The page never compiles WebAssembly: it runs the module the
// markdown worker compiled and posted, which the worker's connection hands here at an idle moment.
// Sätteri's loader reads that module off the global it sets, as the worker's own loader does, and
// the loader, the parser and its cut arrive on chunks of their own the first time the page parser
// starts, never with the window's start. Starting takes one task of some 20 ms, its warm-up parse
// included.

import type { Root } from "mdast";

import { recordRejectedRequest } from "#renderer/lib/diagnostic-capture/rejected-request-record.js";
import { Emitter } from "#renderer/lib/emitter.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { BlockCut, MARKDOWN_SETTLE_LAG_BLOCKS } from "./block-cut.js";
import { loadMarkdownParserCalls, type MarkdownParserCalls } from "./parser-calls.js";

/**
 * Where the page parser stands: not handed a module yet, loading one, ready to parse, or failed to
 * start, or told the worker failed to load the module before the page was handed one.
 */
export type PageParserState = "idle" | "loading" | "ready" | "failed";

/**
 * One page parser: started once from the worker's compiled module, then parsing and cutting
 * synchronously. `loadCalls` imports the parser's calls, after the module is set on the global
 * their loader reads.
 */
export class PageParser {
  readonly #loadCalls: () => Promise<MarkdownParserCalls>;
  readonly #changes = new Emitter<void>("page parser state");
  #state: PageParserState = "idle";
  #calls: MarkdownParserCalls | undefined;
  /** Whether a start has run the loader, which the page's module map holds to what it met. */
  #hasStarted = false;

  public constructor(loadCalls: () => Promise<MarkdownParserCalls>) {
    this.#loadCalls = loadCalls;
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
   * Starts the parser from the module the markdown worker compiled, and warms it up, once: a second
   * import would meet what the page's module map kept from the first, a failure or the module its
   * loader first read. A start that fails is recorded and leaves it `failed` for good; a parser
   * failed with the worker before any start still starts from a later worker's module.
   */
  public start(module: WebAssembly.Module): void {
    if (this.#hasStarted) {
      return;
    }
    this.#hasStarted = true;
    this.#setState("loading");
    (globalThis as SatteriLoaderScope).satteriWasmModule = module;
    void this.#loadCalls().then(
      (calls) => {
        this.#calls = calls;
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
   * `source` parsed into the tree the screen draws, synchronously, a byte order mark it opens on
   * read as text. Throws when the parser is not `ready`, or when the parser breaks on the text.
   */
  public parse(source: string): Root {
    return this.#readyCalls().serializer.parseMarkdownTree(source);
  }

  /**
   * Where the blocks of a body's text `source` end, its last ones too when `isFinal`, cut now as
   * the markdown worker cuts it. Throws as `parse` does.
   */
  public cut(source: string, isFinal: boolean): Uint32Array {
    const { children } = this.#readyCalls();
    return new BlockCut(
      source,
      isFinal,
      MARKDOWN_SETTLE_LAG_BLOCKS,
      children.readTopLevelChildren,
    ).cutWhole();
  }

  #readyCalls(): MarkdownParserCalls {
    const calls = this.#calls;
    if (calls === undefined) {
      throw new Error(`The page's markdown parser is ${this.#state}, not ready`);
    }
    return calls;
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
export const appPageParser: PageParser = new PageParser(loadMarkdownParserCalls);
