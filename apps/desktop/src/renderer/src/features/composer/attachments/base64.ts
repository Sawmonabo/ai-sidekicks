// The console's one base64 encoder: the local wire is JSON, so payload bytes ride as RFC 4648
// section 4 strings. Callers pass a bounded slice (one ingest chunk), never a whole file.

import { BASE64_ENCODE_STRIDE_BYTES } from "./attachment-caps.js";

/**
 * Encode bytes as RFC 4648 section 4 base64, the form the local wire carries payloads in.
 * Encodes in strides because spreading a large array into `String.fromCharCode` overflows the
 * call stack.
 */
export function encodeBase64(bytes: Uint8Array): string {
  let latin1 = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_ENCODE_STRIDE_BYTES) {
    latin1 += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_ENCODE_STRIDE_BYTES));
  }
  return btoa(latin1);
}

/**
 * How many raw bytes a base64 string decodes to, computed from its length and padding without
 * decoding it. Malformed input answers `0` rather than throwing; the daemon's decode is what
 * rejects a bad chunk.
 */
export function base64DecodedByteLength(encoded: string): number {
  if (encoded.length === 0 || encoded.length % 4 !== 0) {
    return 0;
  }
  let paddingCount = 0;
  if (encoded.endsWith("==")) {
    paddingCount = 2;
  } else if (encoded.endsWith("=")) {
    paddingCount = 1;
  }
  return (encoded.length / 4) * 3 - paddingCount;
}
