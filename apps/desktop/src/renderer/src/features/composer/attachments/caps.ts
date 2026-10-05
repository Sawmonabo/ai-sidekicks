// The upload's stall threshold, and the stride the encoder walks a chunk in.

/**
 * Silence after which an in-flight upload says it has gone quiet. The console's own, with no
 * wire source: long enough that a slow-uplink round trip is not a stall, short enough that there
 * is still time to act.
 */
export const INGEST_STALL_DISCLOSURE_MS = 60_000;

/**
 * Bytes one `String.fromCharCode` call converts on the way to base64. A call-stack bound, not a
 * policy one: that function takes its bytes as arguments, so spreading a whole chunk-capped
 * slice overflows the stack on every engine.
 */
export const BASE64_ENCODE_STRIDE_BYTES: number = 8 * 1024;
