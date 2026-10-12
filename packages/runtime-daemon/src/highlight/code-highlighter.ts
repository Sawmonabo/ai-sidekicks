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
import { createHash } from "node:crypto";
import { totalmem } from "node:os";

import type { HighlightLanguage } from "@ai-sidekicks/contracts/highlight";
import { LRUCache } from "lru-cache";

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

/** What the span cache's fetch method tokenizes on a miss. */
interface SpanCacheFetchContext {
  readonly source: string;
  readonly language: HighlightLanguage;
}

/** Colors code and keeps what it colored. One per daemon. */
export class CodeHighlighter {
  readonly #tokenizer = new TokenizerThread();
  readonly #spanCache: LRUCache<string, Uint32Array, SpanCacheFetchContext>;

  constructor() {
    this.#spanCache = new LRUCache<string, Uint32Array, SpanCacheFetchContext>({
      maxSize: spanCacheByteBudget(),
      // Keys are ASCII, so a key's length is its bytes.
      sizeCalculation: (spans, cacheKey) =>
        spans.byteLength + cacheKey.length + SPAN_CACHE_ENTRY_OVERHEAD_BYTES,
      fetchMethod: (_key, _stale, { context }) =>
        this.#tokenizer.tokenize(context.source, context.language),
    });
  }

  /**
   * The packed spans of `source` as `language`: `[offset, length, class]` triples in source
   * order, offsets and lengths in UTF-16 code units. Two reads of the same code share one
   * tokenization, whether the first has finished or is still running.
   */
  async readSpans(source: string, language: HighlightLanguage): Promise<Uint32Array> {
    const cacheKey = `${language}:${createHash("sha256").update(source).digest("base64url")}`;
    return this.#spanCache.forceFetch(cacheKey, { context: { source, language } });
  }

  /** Ends the tokenizing thread and refuses the reads waiting for it and each later cache miss. */
  stop(): Promise<void> {
    return this.#tokenizer.stop();
  }
}
