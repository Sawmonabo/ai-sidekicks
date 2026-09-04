// A content-addressed cache bounded in BYTES rather than in entries.
//
// Two callers, one implementation, hoisted on the second use per
// `apps/desktop/AGENTS.md`: the settled-block parse cache and the highlighter's token
// cache. Both hold values whose sizes span orders of magnitude — a one-line paragraph
// and a pasted file are one entry each and not one cost each — so an entry count is
// the wrong bound for either and would be the wrong bound written twice.
//
// WHY IT MEASURES THE KEY AND NOT THE VALUE. The key is the source text, and the value
// is what parsing or tokenising that text produced. The console cannot measure a node
// tree's retained size without walking it, and walking it on every insert would cost
// more than the cache saves; the source length is exact, free, and proportional to
// what the value costs — `Spec-023 §Console Libraries` measures shiki's retained
// tokens at 21.5x their source precisely because that ratio holds. The BOUND is
// therefore stated in source bytes and each caller's own constant is sized with its
// own ratio in mind.
//
// EVICTION IS LEAST-RECENTLY-USED, and it is a `Map` insertion-order rotation rather
// than a heap: a read moves its entry to the back, an insert appends, and eviction
// takes the front. That is the standard technique and it is here because the
// alternative — a timestamp per entry and a scan — costs a scan per insert to answer
// the same question `Map` iteration order already answers.

/** What one cache reports about itself, so a budget test can read it. */
export interface ByteBoundedCacheStats {
  readonly entryCount: number;
  readonly retainedByteCount: number;
  readonly byteCap: number;
}

export class ByteBoundedCache<TValue> {
  readonly #byteCap: number;
  readonly #entriesByKey = new Map<
    string,
    { readonly value: TValue; readonly byteLength: number }
  >();

  #retainedByteCount = 0;

  public constructor(byteCap: number) {
    this.#byteCap = byteCap;
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
    const byteLength = measureUtf8ByteLength(key);
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

/**
 * UTF-8 byte length of a string.
 *
 * `TextEncoder` rather than `length`, because `length` counts UTF-16 code units and the
 * bound is stated in bytes — the same figure `CONTENT_PAYLOAD_PLAINTEXT_MAX` is stated
 * in, so an emoji-heavy body is charged what it actually costs. Constructed per call
 * rather than held at module scope: a module-level instance is the mutable singleton
 * `apps/desktop/AGENTS.md` rejects, and `encodeInto` on a throwaway encoder is
 * measurably cheaper than the parse this cache exists to skip.
 */
export function measureUtf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
