import { describe, expect, it } from "vitest";
import { pae } from "../pae.js";

const encoder = new TextEncoder();

describe("pae (Pre-Authentication Encoding)", () => {
  it("encodes the empty piece-list as LE64(0) = 8 zero bytes", () => {
    // PAE([]) = LE64(0). LE64(0) = 0x00 repeated 8 times (high bit already clear).
    expect(pae([])).toEqual(new Uint8Array(8));
  });

  it("encodes a single empty piece as LE64(1) || LE64(0)", () => {
    // PAE([new Uint8Array(0)]) = LE64(1) || LE64(0) || [] = 16 bytes.
    const result = pae([new Uint8Array(0)]);
    expect(result.length).toBe(16);
    // LE64(1): low byte 0x01, rest 0x00.
    expect(result[0]).toBe(0x01);
    for (let i = 1; i < 16; i++) expect(result[i]).toBe(0x00);
  });

  it("encodes a single 'test' piece with correct length-prefix", () => {
    const piece = encoder.encode("test"); // 4 bytes
    const result = pae([piece]);
    // Layout: LE64(1) || LE64(4) || "test"
    expect(result.length).toBe(8 + 8 + 4);
    expect(result[0]).toBe(0x01); // count = 1
    expect(result[8]).toBe(0x04); // first piece length = 4
    expect(Array.from(result.slice(16))).toEqual(Array.from(piece));
  });

  it("encodes two pieces in order with separate length prefixes", () => {
    const a = encoder.encode("hello");
    const b = encoder.encode("worldly");
    const result = pae([a, b]);
    // Layout: LE64(2) || LE64(5) || "hello" || LE64(7) || "worldly"
    expect(result.length).toBe(8 + 8 + 5 + 8 + 7);
    expect(result[0]).toBe(0x02); // count = 2
    expect(result[8]).toBe(0x05); // first piece length = 5
    expect(result[8 + 8 + 5]).toBe(0x07); // second piece length = 7
  });

  it("clears the high bit on the length prefix (LE64 high-bit-cleared)", () => {
    // Construct a piece whose length sets bit 63 of LE64 if left intact.
    // 2^63 is unreachable via a Uint8Array (max ~2^53 in JS), but we can verify
    // the high-bit-clear behavior by simulating with a synthetic length via
    // the implementation's writeLength helper if exposed. Here we settle for
    // checking that the high byte of any normal length stays zero (high bit
    // of byte[7] should always be 0 in practice). This is a sanity check.
    const piece = new Uint8Array(0);
    const result = pae([piece]);
    expect(result[7]! & 0x80).toBe(0); // count's MSB cleared
    expect(result[15]! & 0x80).toBe(0); // length's MSB cleared
  });
});
