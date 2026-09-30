import { describe, expect, it } from "vitest";

import { measureUtf8ByteLength } from "./utf8-byte-length.js";

describe("the ruler itself, which every cap in this console spends", () => {
  it("counts UTF-8 bytes and not UTF-16 code units", () => {
    // Caps are in bytes, so a character is charged what it costs on the wire.
    expect(measureUtf8ByteLength("abc")).toBe(3);
    expect(measureUtf8ByteLength("é")).toBe(2);
    expect(measureUtf8ByteLength("🙂")).toBe(4);
  });

  it("negative control: it is not `String.length`", () => {
    // A cap counting code units passes every ASCII case yet admits four times what it claims.
    expect(measureUtf8ByteLength("🙂")).not.toBe("🙂".length);
    expect(measureUtf8ByteLength("abc")).toBe("abc".length);
  });
});
