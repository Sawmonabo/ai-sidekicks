import { describe, expect, it } from "vitest";

import { jsonUtf8ByteLength } from "../jsonrpc/byte-length.js";
import { SCHEMA_FORMATS, wireByteLength } from "../schema-check.js";

describe("wireByteLength", () => {
  it("counts every attachment a nested placeholder names beside the JSON", () => {
    const value = { entries: [{ audio: { $bytes: 0 } }, { image: { $bytes: 1 } }] };
    expect(wireByteLength(value, [new Uint8Array(10), new Uint8Array(7)])).toBe(
      jsonUtf8ByteLength(value) + 17,
    );
  });

  it("measures infinite where a placeholder names no attachment", () => {
    expect(wireByteLength({ audio: { $bytes: 1 } }, [new Uint8Array(10)])).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(wireByteLength({ audio: { $bytes: 0 } }, undefined)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("SCHEMA_FORMATS", () => {
  it("takes a web address only when it parses with an http: or https: scheme", () => {
    const isWebAddress = SCHEMA_FORMATS["web-url"];
    expect(isWebAddress("  https://example.com/  ")).toBe(true);
    expect(isWebAddress("HTTP://x")).toBe(true);
    expect(isWebAddress("ftp://example.com/file")).toBe(false);
    expect(isWebAddress("javascript:alert(1)")).toBe(false);
    expect(isWebAddress("https://")).toBe(false);
  });

  it("holds a number to its Rust integer type's range", () => {
    expect(SCHEMA_FORMATS.uint32.validate(0xffff_ffff)).toBe(true);
    expect(SCHEMA_FORMATS.uint32.validate(0x1_0000_0000)).toBe(false);
    expect(SCHEMA_FORMATS.uint32.validate(-1)).toBe(false);
    expect(SCHEMA_FORMATS.uint32.validate(1.5)).toBe(false);
    expect(SCHEMA_FORMATS.int64.validate(-(2 ** 63))).toBe(true);
    expect(SCHEMA_FORMATS.int64.validate(2 ** 64)).toBe(false);
    expect(SCHEMA_FORMATS.int64.validate(-(2 ** 64))).toBe(false);
  });
});
