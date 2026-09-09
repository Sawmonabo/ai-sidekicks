// The encoder, held to the round trip rather than to a table of expected strings.
//
// The oracle is the platform's own `atob` and never a decoder this console wrote:
// a round trip through two functions written together passes whenever they are
// wrong in mirrored ways, which is exactly the failure a byte-for-byte transport
// check exists to catch.

import { describe, expect, it } from "vitest";

import { base64DecodedByteLength, encodeBase64 } from "./base64.js";
import { BASE64_ENCODE_STRIDE_BYTES } from "./constants/attachment-caps.js";

/** Decode with the platform, so the assertion is against RFC 4648 and not against us. */
function decodeWithPlatform(encoded: string): Uint8Array<ArrayBuffer> {
  const latin1 = atob(encoded);
  const bytes = new Uint8Array(latin1.length);
  for (let index = 0; index < latin1.length; index += 1) {
    bytes[index] = latin1.charCodeAt(index);
  }
  return bytes;
}

/** Bytes that walk the whole 0–255 range, so a high byte truncated to 7 bits shows up. */
function everyByteValue(repeats: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(256 * repeats);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = index % 256;
  }
  return bytes;
}

describe("base64 — the round trip", () => {
  it("returns the same bytes through the platform decoder", () => {
    const bytes = everyByteValue(1);
    expect(decodeWithPlatform(encodeBase64(bytes))).toStrictEqual(bytes);
  });

  it("encodes across the stride boundary without dropping or repeating a byte", () => {
    // The stride is a call-stack bound, so the seam between two `fromCharCode`
    // calls is the one place a length can be lost. This input spans several.
    const bytes = everyByteValue(Math.ceil((BASE64_ENCODE_STRIDE_BYTES * 3) / 256));
    expect(bytes.length).toBeGreaterThan(BASE64_ENCODE_STRIDE_BYTES * 2);
    expect(decodeWithPlatform(encodeBase64(bytes))).toStrictEqual(bytes);
  });

  it("pads the two remainder lengths the way the encoding requires", () => {
    expect(encodeBase64(new Uint8Array([0x66]))).toBe("Zg==");
    expect(encodeBase64(new Uint8Array([0x66, 0x6f]))).toBe("Zm8=");
    expect(encodeBase64(new Uint8Array([0x66, 0x6f, 0x6f]))).toBe("Zm9v");
  });

  it("encodes nothing as nothing", () => {
    expect(encodeBase64(new Uint8Array(0))).toBe("");
  });

  it("negative control: the oracle rejects bytes the encoder did not produce", () => {
    // Without this, every assertion above would pass over a decoder that answered
    // the input it was compared against.
    const bytes = everyByteValue(1);
    expect(decodeWithPlatform(encodeBase64(bytes.subarray(1)))).not.toStrictEqual(bytes);
  });
});

/** Exactly this many bytes, so the count under test has an exact expected answer. */
function bytesOfLength(byteCount: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(byteCount);
  for (let index = 0; index < byteCount; index += 1) {
    bytes[index] = index % 256;
  }
  return bytes;
}

describe("base64DecodedByteLength", () => {
  it("counts what the encoder put in, for every remainder length", () => {
    // Held to the ENCODER rather than to a table, on the round-trip reasoning above:
    // the count and the encoding are one seam, so the oracle is what the seam produced.
    for (let byteCount = 0; byteCount <= 96; byteCount += 1) {
      const encoded = encodeBase64(bytesOfLength(byteCount));
      expect(base64DecodedByteLength(encoded)).toBe(byteCount);
    }
  });

  it("answers zero for a string no encoder produced rather than throwing", () => {
    // A count is not a validator: the daemon's own decode rejects a bad chunk, and a
    // length that threw would put a `try` around arithmetic at every call site.
    expect(base64DecodedByteLength("Zm9")).toBe(0);
    expect(base64DecodedByteLength("Z")).toBe(0);
  });

  it("negative control: the count is not the encoded length", () => {
    // Without this, an implementation returning `encoded.length` would pass the
    // zero case and nothing else would report it.
    const encoded = encodeBase64(bytesOfLength(48));
    expect(base64DecodedByteLength(encoded)).not.toBe(encoded.length);
  });
});
