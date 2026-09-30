// A content-addressed cache bounded in BYTES rather than in entries.
//
// Two callers, one implementation: the settled-block parse cache and the code block's
// color span cache. Both hold values whose sizes span orders of magnitude — a
// one-line paragraph and a pasted file are one entry each and not one cost each — so an
// entry count is the wrong bound for either and would be the wrong bound written twice.
//
// WHAT IT CHARGES. Always the key, which is the source text the cache holds on to.
// The value too, when its caller can measure it: a node tree's retained size cannot be
// had without walking it, and walking it on every insert would cost more than the cache
// saves, so the parse cache charges its key alone and sizes its bound with that in
// mind; a span list is one typed array whose byte length is exact and free, so the
// span cache charges both and its bound is what the cache really holds.
//
// EVICTION IS LEAST-RECENTLY-USED, and it is a `Map` insertion-order rotation rather
// than a heap: a read moves its entry to the back, an insert appends, and eviction
// takes the front. That is the standard technique and it is here because the
// alternative — a timestamp per entry and a scan — costs a scan per insert to answer
// the same question `Map` iteration order already answers.

// The console's one byte measurement, imported from the module that owns it: one
// byte-measurement function serves every cap, so no two caps can disagree about how
// large one body is.
import { measureUtf8ByteLength } from "@renderer/lib/utf8-byte-length.js";

/** What one cache reports about itself, so a budget test can read it. */
export interface ByteBoundedCacheStats {
  readonly entryCount: number;
  readonly retainedByteCount: number;
  readonly byteCap: number;
}

export class ByteBoundedCache<TValue> {
  readonly #byteCap: number;
  readonly #measureValueBytes: ((value: TValue) => number) | undefined;
  readonly #entriesByKey = new Map<
    string,
    { readonly value: TValue; readonly byteLength: number }
  >();

  #retainedByteCount = 0;

  /** `measureValueBytes`, where given, adds each value's own bytes to its key's. */
  public constructor(byteCap: number, measureValueBytes?: (value: TValue) => number) {
    this.#byteCap = byteCap;
    this.#measureValueBytes = measureValueBytes;
  }

  /**
   * The value for this key, or `undefined`.
   *
   * A hit re-inserts, which is what makes the `Map`'s insertion order a recency order.
   */
  public get(key: string): TValue | undefined {
    const entry = this.#entriesByKey.get(key);
    if (entry === undefined) {
      return undefined;
    }
    this.#entriesByKey.delete(key);
    this.#entriesByKey.set(key, entry);
    return entry.value;
  }

  /**
   * Store a value under its own source text.
   *
   * A single entry larger than the whole cap is DROPPED rather than stored and
   * immediately evicted: storing it would clear every other entry to make room for
   * something the next insert removes again, which is a cache that behaves worse than
   * no cache at all on exactly the input that motivated the bound.
   */
  public set(key: string, value: TValue): void {
    const byteLength = measureUtf8ByteLength(key) + (this.#measureValueBytes?.(value) ?? 0);
    if (byteLength > this.#byteCap) {
      return;
    }
    const existing = this.#entriesByKey.get(key);
    if (existing !== undefined) {
      this.#retainedByteCount -= existing.byteLength;
      this.#entriesByKey.delete(key);
    }
    this.#entriesByKey.set(key, { value, byteLength });
    this.#retainedByteCount += byteLength;
    this.#evictToCap();
  }

  public stats(): ByteBoundedCacheStats {
    return {
      entryCount: this.#entriesByKey.size,
      retainedByteCount: this.#retainedByteCount,
      byteCap: this.#byteCap,
    };
  }

  /** Forget everything. The cap survives — it is how the cache was built. */
  public clear(): void {
    this.#entriesByKey.clear();
    this.#retainedByteCount = 0;
  }

  #evictToCap(): void {
    for (const [key, entry] of this.#entriesByKey) {
      if (this.#retainedByteCount <= this.#byteCap) {
        return;
      }
      this.#entriesByKey.delete(key);
      this.#retainedByteCount -= entry.byteLength;
    }
  }
}
