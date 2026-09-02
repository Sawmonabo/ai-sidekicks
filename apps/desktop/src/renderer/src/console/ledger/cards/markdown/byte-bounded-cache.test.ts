// A bound that is spent in bytes, and a cache that never thrashes on the one input the
// bound exists for.

import { describe, expect, it } from "vitest";

import { ByteBoundedCache, measureUtf8ByteLength } from "./byte-bounded-cache.js";

describe("measuring a string in bytes", () => {
  it("counts UTF-8 bytes and not UTF-16 code units", () => {
    // The bound is stated in bytes, so an emoji is charged what it costs on the wire.
    expect(measureUtf8ByteLength("abc")).toBe(3);
    expect(measureUtf8ByteLength("é")).toBe(2);
    expect(measureUtf8ByteLength("🙂")).toBe(4);
  });

  it("negative control: it is not `String.length`", () => {
    expect(measureUtf8ByteLength("🙂")).not.toBe("🙂".length);
  });
});

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
    // Storing it would evict everything to make room for something the next insert
    // removes again — a cache that behaves worse than no cache on its worst input.
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
