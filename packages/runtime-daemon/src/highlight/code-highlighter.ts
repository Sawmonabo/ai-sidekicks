// The daemon's one colorer: a span cache keyed on what the source holds, on the daemon's main
// thread, over a tokenizing thread that colors a source the cache does not hold yet. The cache
// outlives the thread, which ends when it sits idle, so code already colored is answered at once.
//
// Spans are kept packed. A source's spans are one `Uint32Array` of `[offset, length, class]`
// triples, adjacent spans of one class merged and plain text left out, which holds a source's
// colors in well under a byte per source byte where one object per token holds several. The
// cache is bounded by what its entries hold (1/2048 of physical memory) and keyed by the language
// and a digest of the source, so the same code asked for twice is colored once and the cache never
// holds the source itself. A source with a line left plain because it ran past the time limit is
// kept too, since coloring it again would hold the thread on the same line.
//
// The reads waiting to be colored are bounded by what still wants them: reads of the same code
// share one tokenization; a read for a code block is replaced by the block's next read on the same
// connection, as a block whose code is still arriving asks again for each version; and a
// connection's reads go when it closes. A tokenization no read waits for any more leaves the line
// before its turn, so at most one waits per block and connection.
import { createHash } from "node:crypto";
import { totalmem } from "node:os";

import {
  HIGHLIGHT_READ_REPLACED_CODE,
  type HighlightLanguage,
} from "@ai-sidekicks/contracts/highlight";
import { LRUCache } from "lru-cache";

import { DaemonDomainError } from "../ipc/domain-error.js";
import { TokenizerThread } from "./thread.js";

/** The span cache's budget: 1/2048 of the machine's physical memory. */
function spanCacheByteBudget(): number {
  return Math.floor(totalmem() / 2048);
}

/**
 * Bytes a span cache entry costs beyond its key's characters and its spans' bytes: the key
 * string's header, the cache's map entry and its per-entry list slots, and the typed array and
 * buffer objects. Measured on Node 24 at 336 to 352 bytes for keys of the cache's shape.
 */
const SPAN_CACHE_ENTRY_OVERHEAD_BYTES = 352;

/** What the span cache's fetch method tokenizes on a miss, and the signal that drops it. */
interface SpanCacheFetchContext {
  readonly source: string;
  readonly language: HighlightLanguage;
  readonly signal: AbortSignal;
}

/** Who asks for a read: the connection, and the code block on it the read is for, if any. */
export interface SpanReadAsker {
  readonly transportId: number;
  readonly blockId: string | undefined;
}

/** One tokenization in flight, shared by every read of the same code. */
interface SpanFetch {
  readonly spans: Promise<Uint32Array>;
  // Aborted once no read waits for the spans, which drops a tokenization still waiting its turn.
  readonly unwanted: AbortController;
  readerCount: number;
}

/** One read waiting for a fetch, which leaves it once, answered or dropped. */
interface WaitingRead {
  readonly fetch: SpanFetch;
  readonly asker: SpanReadAsker | undefined;
  readonly reject: (reason: Error) => void;
  hasLeft: boolean;
}

/** Colors code and keeps what it colored. One per daemon. */
export class CodeHighlighter {
  readonly #tokenizer = new TokenizerThread();
  readonly #spanCache: LRUCache<string, Uint32Array, SpanCacheFetchContext>;
  readonly #fetches = new Map<string, SpanFetch>();
  readonly #readsByBlock = new Map<string, WaitingRead>();
  readonly #readsByTransport = new Map<number, Set<WaitingRead>>();

  constructor() {
    this.#spanCache = new LRUCache<string, Uint32Array, SpanCacheFetchContext>({
      maxSize: spanCacheByteBudget(),
      // Keys are ASCII, so a key's length is its bytes.
      sizeCalculation: (spans, cacheKey) =>
        spans.byteLength + cacheKey.length + SPAN_CACHE_ENTRY_OVERHEAD_BYTES,
      fetchMethod: (_key, _stale, { context }) =>
        this.#tokenizer.tokenize(context.source, context.language, context.signal),
    });
  }

  /**
   * The packed spans of `source` as `language`: `[offset, length, class]` triples in source
   * order, offsets and lengths in UTF-16 code units. Two reads of the same code share one
   * tokenization, whether the first has finished or is still running. A read `asker` names is
   * refused with `highlight.read_replaced` when the same block asks again before it is answered,
   * and dropped when its connection closes.
   */
  readSpans(
    source: string,
    language: HighlightLanguage,
    asker?: SpanReadAsker,
  ): Promise<Uint32Array> {
    const cacheKey = `${language}:${createHash("sha256").update(source).digest("base64url")}`;
    const held = this.#spanCache.get(cacheKey);
    if (held !== undefined) {
      return Promise.resolve(held);
    }
    const fetch = this.#fetches.get(cacheKey) ?? this.#startFetch(cacheKey, source, language);
    fetch.readerCount += 1;
    const { promise, resolve, reject } = Promise.withResolvers<Uint32Array>();
    const read: WaitingRead = { fetch, asker, reject, hasLeft: false };
    this.#holdRead(read);
    fetch.spans.then(
      (spans) => {
        this.#leave(read);
        resolve(spans);
      },
      (error: unknown) => {
        this.#leave(read);
        reject(error as Error);
      },
    );
    return promise;
  }

  /** Drops every read the connection `transportId` is waiting for, since it has closed. */
  dropReadsOf(transportId: number): void {
    for (const read of this.#readsByTransport.get(transportId) ?? []) {
      this.#drop(read, new Error("The connection that asked for the colors has closed"));
    }
  }

  /** Ends the tokenizing thread and refuses the reads waiting for it and each later cache miss. */
  stop(): Promise<void> {
    return this.#tokenizer.stop();
  }

  #startFetch(cacheKey: string, source: string, language: HighlightLanguage): SpanFetch {
    const unwanted = new AbortController();
    const fetch: SpanFetch = {
      spans: this.#spanCache.forceFetch(cacheKey, {
        context: { source, language, signal: unwanted.signal },
      }),
      unwanted,
      readerCount: 0,
    };
    this.#fetches.set(cacheKey, fetch);
    const release = (): void => {
      if (this.#fetches.get(cacheKey) === fetch) {
        this.#fetches.delete(cacheKey);
      }
    };
    fetch.spans.then(release, release);
    return fetch;
  }

  // Joins the read to its connection's and block's, replacing the block's earlier read. The new
  // read has already joined its fetch, so a block asking again for the same code keeps it.
  #holdRead(read: WaitingRead): void {
    if (read.asker === undefined) {
      return;
    }
    const { transportId, blockId } = read.asker;
    const transportReads = this.#readsByTransport.get(transportId) ?? new Set<WaitingRead>();
    transportReads.add(read);
    this.#readsByTransport.set(transportId, transportReads);
    if (blockId === undefined) {
      return;
    }
    const blockKey = blockKeyOf(transportId, blockId);
    const replaced = this.#readsByBlock.get(blockKey);
    this.#readsByBlock.set(blockKey, read);
    if (replaced !== undefined) {
      this.#drop(
        replaced,
        new DaemonDomainError("A newer read for the same code block replaced this one", {
          code: HIGHLIGHT_READ_REPLACED_CODE,
        }),
      );
    }
  }

  #drop(read: WaitingRead, reason: Error): void {
    if (read.hasLeft) {
      return;
    }
    this.#leave(read);
    read.reject(reason);
    if (read.fetch.readerCount === 0) {
      read.fetch.unwanted.abort(reason);
    }
  }

  #leave(read: WaitingRead): void {
    if (read.hasLeft) {
      return;
    }
    read.hasLeft = true;
    read.fetch.readerCount -= 1;
    if (read.asker === undefined) {
      return;
    }
    const { transportId, blockId } = read.asker;
    const transportReads = this.#readsByTransport.get(transportId);
    transportReads?.delete(read);
    if (transportReads?.size === 0) {
      this.#readsByTransport.delete(transportId);
    }
    if (blockId === undefined) {
      return;
    }
    const blockKey = blockKeyOf(transportId, blockId);
    if (this.#readsByBlock.get(blockKey) === read) {
      this.#readsByBlock.delete(blockKey);
    }
  }
}

/** A block's key among every connection's blocks. */
function blockKeyOf(transportId: number, blockId: string): string {
  return `${String(transportId)}:${blockId}`;
}
