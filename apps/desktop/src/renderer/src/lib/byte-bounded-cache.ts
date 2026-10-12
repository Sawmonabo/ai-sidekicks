// A cache bounded in bytes, not entries: cached bodies range from one line to a pasted file.
// The key (the source text) is always charged, and the value too when the caller can measure it.
// Eviction is least-recently-used, using `Map` insertion order. An entry a caller holds is kept
// whatever its size and charged like any other, so while it is held the rest give way to it. The
// entries no one holds are kept in their own order too, so passing the cap visits only those it
// evicts, however many entries are held.

import { measureUtf8ByteLength } from "#renderer/lib/text/utf8-byte-length.js";

/** Content-addressed LRU cache with a byte cap; an entry larger than the cap is not stored. */
export class ByteBoundedCache<TValue> {
  readonly #byteCap: number;
  readonly #measureValueBytes: ((value: TValue) => number) | undefined;
  readonly #entriesByKey = new Map<string, CacheEntry<TValue>>();
  /** The entries no one holds, least recently used first: the ones eviction may take. */
  readonly #unheldEntriesByKey = new Map<string, CacheEntry<TValue>>();

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
    if (entry.holdCount === 0) {
      this.#unheldEntriesByKey.delete(key);
      this.#unheldEntriesByKey.set(key, entry);
    }
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
    this.#store(key, value, byteLength, this.#entriesByKey.get(key)?.holdCount ?? 0);
  }

  /**
   * Store a value and hold it: it is kept, whatever its size, until each hold on it is released.
   * What bounds the held entries is their holders, each releasing its hold once.
   */
  public setHeld(key: string, value: TValue): void {
    const byteLength = measureUtf8ByteLength(key) + (this.#measureValueBytes?.(value) ?? 0);
    this.#store(key, value, byteLength, (this.#entriesByKey.get(key)?.holdCount ?? 0) + 1);
  }

  /** Hold the entry under `key`, if one is cached; answers whether one was. */
  public hold(key: string): boolean {
    const entry = this.#entriesByKey.get(key);
    if (entry === undefined) {
      return false;
    }
    entry.holdCount += 1;
    this.#unheldEntriesByKey.delete(key);
    return true;
  }

  /** Release one hold on the entry under `key`; released by every holder, it can be evicted. */
  public release(key: string): void {
    const entry = this.#entriesByKey.get(key);
    if (entry === undefined || entry.holdCount === 0) {
      return;
    }
    entry.holdCount -= 1;
    if (entry.holdCount === 0) {
      this.#unheldEntriesByKey.set(key, entry);
      this.#evictToCap();
    }
  }

  /** Forget everything. The cap survives — it is how the cache was built. */
  public clear(): void {
    this.#entriesByKey.clear();
    this.#unheldEntriesByKey.clear();
    this.#retainedByteCount = 0;
  }

  #store(key: string, value: TValue, byteLength: number, holdCount: number): void {
    const existing = this.#entriesByKey.get(key);
    if (existing !== undefined) {
      this.#retainedByteCount -= existing.byteLength;
      this.#unheldEntriesByKey.delete(key);
    }
    const entry = { value, byteLength, holdCount };
    this.#entriesByKey.set(key, entry);
    if (holdCount === 0) {
      this.#unheldEntriesByKey.set(key, entry);
    }
    this.#retainedByteCount += byteLength;
    this.#evictToCap();
  }

  #evictToCap(): void {
    for (const [key, entry] of this.#unheldEntriesByKey) {
      if (this.#retainedByteCount <= this.#byteCap) {
        return;
      }
      this.#unheldEntriesByKey.delete(key);
      this.#entriesByKey.delete(key);
      this.#retainedByteCount -= entry.byteLength;
    }
  }
}

/** One cached value, its charge, and how many holders keep it from eviction. */
interface CacheEntry<TValue> {
  readonly value: TValue;
  readonly byteLength: number;
  holdCount: number;
}
