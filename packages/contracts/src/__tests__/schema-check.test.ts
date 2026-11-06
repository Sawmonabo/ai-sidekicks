import { describe, expect, it } from "vitest";

import { jsonUtf8ByteLength } from "../jsonrpc/byte-length.js";
import { wireByteLength } from "../schema-check.js";

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
