// The encoding cases (UTF-8 against UTF-16, surrogate pairs) live with the byte-length
// function's own tests; this suite asks only what the cache does with a measurement.

import { describe, expect, it } from "vitest";

import { measureUtf8ByteLength } from "@renderer/lib/utf8-byte-length.js";
import { ByteBoundedCache } from "./byte-bounded-cache.js";

describe("the byte-bounded cache", () => {
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

  it("re-inserting one key does not double-count its bytes", () => {
    // The cap holds exactly two five-byte keys, so a doubled charge for `alpha` would evict it.
    const cache = new ByteBoundedCache<number>(2 * measureUtf8ByteLength("alpha"));
    cache.set("alpha", 1);
    cache.set("alpha", 2);
    cache.set("bravo", 3);
    expect(cache.get("alpha")).toBe(2);
    expect(cache.get("bravo")).toBe(3);
  });

  it("charges a value its caller can measure beside its key", () => {
    // A span cache that charged only the source would hold its spans outside its bound.
    const cache = new ByteBoundedCache<Uint32Array>(16, (spans) => spans.byteLength);
    cache.set("abcd", new Uint32Array(3));
    cache.set("abcde", new Uint32Array(3));
    expect(cache.get("abcde")).toBeUndefined();
    expect(cache.get("abcd")).not.toBeUndefined();
  });
});
