// The console's one base64 encoder.
//
// It exists because the local wire is JSON with no binary serialization
// (`Spec-007 §Wire Format`), so any payload byte that has to reach the daemon
// rides as an RFC 4648 §4 string. There is exactly one such payload in this
// console today — an attachment ingest chunk — and there will be more, which is
// why the encoder is a core leaf rather than a private function inside the ingest
// client: a second copy would drift from this one and both would look right.
//
// IT ENCODES A SLICE, NOT A FILE. The parameter is a `Uint8Array` the caller
// already holds, and the caller's obligation is to hold a BOUNDED one: the ingest
// client reads one chunk-capped slice out of a `Blob` at a time, so a hundred
// megabyte upload never has more than one chunk decoded and one chunk encoded in
// memory at once. Handing this function a whole file's bytes would be the defect,
// and the shape of the parameter is what keeps that visible at every call site.
//
// IT IS `btoa` AND NOT A HAND-ROLLED TABLE. The platform ships the encoder; the
// only thing this module adds is the stride, because `String.fromCharCode` takes
// its bytes as ARGUMENTS and a spread of half a million of them overflows the
// call stack. Everything else here would be a re-implementation of a primitive
// the runtime already has, which `apps/desktop/AGENTS.md` rejects by name.

import { BASE64_ENCODE_STRIDE_BYTES } from "./constants.js";

/**
 * Encode bytes as RFC 4648 §4 base64, the form the local wire carries payloads in.
 *
 * The intermediate is a latin-1 string rather than an array of characters: one
 * rope of the byte count, which the engine concatenates without copying, instead
 * of one string object per character.
 */
export function encodeBase64(bytes: Uint8Array): string {
  let latin1 = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_ENCODE_STRIDE_BYTES) {
    latin1 += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_ENCODE_STRIDE_BYTES));
  }
  return btoa(latin1);
}
