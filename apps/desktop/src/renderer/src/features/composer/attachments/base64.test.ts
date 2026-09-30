// The encoder is checked by round trip through the platform's `atob`, never a decoder this
// console wrote: two functions written together can be wrong in mirrored ways and still agree.

import { describe, expect, it } from "vitest";

import { base64DecodedByteLength, encodeBase64 } from "./base64.js";
import { BASE64_ENCODE_STRIDE_BYTES } from "./attachment-caps.js";

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
    // The stride bounds the call stack, so the seam between two `fromCharCode` calls is where a
    // length could be lost; this input spans several strides.
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
    // Without this, the assertions above would pass over a decoder that echoed its input.
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
    // Held to the encoder's output: the count and the encoding are one seam.
    for (let byteCount = 0; byteCount <= 96; byteCount += 1) {
      const encoded = encodeBase64(bytesOfLength(byteCount));
      expect(base64DecodedByteLength(encoded)).toBe(byteCount);
    }
  });

  it("answers zero for a string no encoder produced rather than throwing", () => {
    // A count is not a validator; the daemon's decode rejects a bad chunk.
    expect(base64DecodedByteLength("Zm9")).toBe(0);
    expect(base64DecodedByteLength("Z")).toBe(0);
  });

  it("negative control: the count is not the encoded length", () => {
    // An implementation returning `encoded.length` would pass the zero case alone.
    const encoded = encodeBase64(bytesOfLength(48));
    expect(base64DecodedByteLength(encoded)).not.toBe(encoded.length);
  });
});
