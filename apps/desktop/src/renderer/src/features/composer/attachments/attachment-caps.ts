// The ingest stream's time bounds, and the stride the encoder walks a chunk in. The stream
// ceiling is enforced by the daemon and carried here to explain the bound ahead of the refusal;
// it is operator-tunable, so a view shows it as "default" until the daemon answers.

/**
 * Wall-clock ceiling on one ingest stream, measured from its first call
 * (`max_ingest_stream_lifetime`, operator-tunable over 1 to 24 hours). The abandoned-spool reaper
 * clocks file modification time, which a trickle of chunks refreshes forever, so live streams
 * need their own clock. Surfaced on a stalled upload as the one expiry a user cannot otherwise
 * see coming.
 */
export const INGEST_STREAM_LIFETIME_CEILING_MS: number = 6 * 60 * 60 * 1000;

/**
 * Silence after which an in-flight upload discloses the stream ceiling. The console's own, with
 * no wire source: long enough that a slow-uplink round trip is not a stall, short enough that
 * there is still time to act, and far inside the ceiling.
 */
export const INGEST_STALL_DISCLOSURE_MS = 60_000;

/**
 * Bytes one `String.fromCharCode` call converts on the way to base64. A call-stack bound, not a
 * policy one: that function takes its bytes as arguments, so spreading a whole chunk-capped
 * slice overflows the stack on every engine.
 */
export const BASE64_ENCODE_STRIDE_BYTES: number = 8 * 1024;
