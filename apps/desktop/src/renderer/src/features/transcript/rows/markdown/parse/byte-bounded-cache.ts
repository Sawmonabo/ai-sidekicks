// A cache bounded in bytes, not entries: cached bodies range from one line to a pasted file.
// The key (the source text) is always charged, and the value too when the caller can measure it.
// Eviction is least-recently-used, using `Map` insertion order.

import { measureUtf8ByteLength } from "@renderer/lib/utf8-byte-length.js";

/** What one cache reports about itself, so a budget test can read it. */
export interface ByteBoundedCacheStats {
  readonly entryCount: number;
  readonly retainedByteCount: number;
  readonly byteCap: number;
}

/** Content-addressed LRU cache with a byte cap; an entry larger than the cap is not stored. */
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

  /** The value for this key, or `undefined`; a hit moves the entry to most recently used. */
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
   * An entry larger than the whole cap is dropped, not stored: storing it would evict every
   * other entry for something the next insert removes again.
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
