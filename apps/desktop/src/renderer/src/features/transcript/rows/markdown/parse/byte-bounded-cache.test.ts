// The encoding cases (UTF-8 against UTF-16, surrogate pairs) live with the byte-length
// function's own tests; this suite asks only what the cache does with a measurement.

import { describe, expect, it } from "vitest";

import { measureUtf8ByteLength } from "@renderer/lib/utf8-byte-length.js";
import { ByteBoundedCache } from "./byte-bounded-cache.js";

describe("the byte-bounded cache", () => {
  it("returns what it was given", () => {
    const cache = new ByteBoundedCache<number>(64);
    cache.set("alpha", 1);
    expect(cache.get("alpha")).toBe(1);
  });

  it("evicts the least recently used entry when the cap is passed", () => {
    const cache = new ByteBoundedCache<number>(10);
    cache.set("aaaaa", 1);
    cache.set("bbbbb", 2);
    cache.get("aaaaa");
    cache.set("ccccc", 3);
    expect(cache.get("bbbbb")).toBeUndefined();
    expect(cache.get("aaaaa")).toBe(1);
    expect(cache.get("ccccc")).toBe(3);
  });

  it("drops a single entry larger than the whole cap rather than clearing the cache", () => {
    // Storing it would evict everything for something the next insert removes again.
    const cache = new ByteBoundedCache<number>(8);
    cache.set("small", 1);
    cache.set("a".repeat(64), 2);
    expect(cache.get("a".repeat(64))).toBeUndefined();
    expect(cache.get("small")).toBe(1);
  });

  it("negative control: an insert inside the cap evicts nothing", () => {
    // Without this, a cache that evicted on every insert would pass the cases above.
    const cache = new ByteBoundedCache<number>(1024);
    cache.set("alpha", 1);
    cache.set("beta", 2);
    expect(cache.stats().entryCount).toBe(2);
    expect(cache.get("alpha")).toBe(1);
  });

  it("re-inserting one key does not double-count its bytes", () => {
    const cache = new ByteBoundedCache<number>(1024);
    cache.set("alpha", 1);
    cache.set("alpha", 2);
    expect(cache.stats().entryCount).toBe(1);
    expect(cache.stats().retainedByteCount).toBe(measureUtf8ByteLength("alpha"));
    expect(cache.get("alpha")).toBe(2);
  });

  it("charges a value its caller can measure beside its key", () => {
    // A span cache that charged only the source would hold its spans outside its bound.
    const cache = new ByteBoundedCache<Uint32Array>(16, (spans) => spans.byteLength);
    cache.set("abcd", new Uint32Array(3));
    expect(cache.stats().retainedByteCount).toBe(16);
    cache.set("abcde", new Uint32Array(3));
    expect(cache.get("abcde")).toBeUndefined();
    expect(cache.get("abcd")).not.toBeUndefined();
  });

  it("reports its own bound, so a budget test reads it rather than restating it", () => {
    expect(new ByteBoundedCache<number>(4096).stats().byteCap).toBe(4096);
  });

  it("clears its entries and keeps its bound", () => {
    const cache = new ByteBoundedCache<number>(256);
    cache.set("alpha", 1);
    cache.clear();
    expect(cache.stats()).toStrictEqual({ entryCount: 0, retainedByteCount: 0, byteCap: 256 });
  });
});
