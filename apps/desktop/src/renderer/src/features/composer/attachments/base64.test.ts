// The encoder is checked by round trip through the platform's `atob`, never a decoder this
// console wrote: two functions written together can be wrong in mirrored ways and still agree.

import { describe, expect, it } from "vitest";

import { encodeBase64 } from "./base64.js";
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
  it("encodes across the stride boundary without dropping or repeating a byte", () => {
    // The stride bounds the call stack, so the seam between two `fromCharCode` calls is where a
    // length could be lost; this input spans several strides.
    const bytes = everyByteValue(Math.ceil((BASE64_ENCODE_STRIDE_BYTES * 3) / 256));
    expect(bytes.length).toBeGreaterThan(BASE64_ENCODE_STRIDE_BYTES * 2);
    expect(decodeWithPlatform(encodeBase64(bytes))).toStrictEqual(bytes);
  });
});
