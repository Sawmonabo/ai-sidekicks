// The ingest stream's time bounds, and the stride the encoder walks a chunk in.

// The byte and count limits are the contract's (`SESSION_ATTACHMENT_BYTES_DEFAULT_LIMIT`,
// `SESSION_ATTACHMENTS_PER_MESSAGE_DEFAULT_LIMIT`) and the chunk size is
// `ATTACHMENT_INGEST_CHUNK_MAX_BYTES`. The stream ceiling below is enforced by the daemon;
// the console carries it to explain the bound ahead of the refusal. It is
// operator-tunable, so a view that shows it says "default" until the daemon answers with
// the value in force.

/**
 * Wall-clock ceiling on one ingest stream, measured from its first call.
 *
 * `max_ingest_stream_lifetime`. The abandoned-spool reaper clocks file
 * modification time, which a trickle of chunks refreshes forever, so live-stream
 * tenure needs its own clock. Surfaced on a stalled upload because it is the one
 * bound whose expiry a user cannot otherwise see coming. Operator-tunable
 * over a 1 – 24 hour range.
 */
export const INGEST_STREAM_LIFETIME_CEILING_MS: number = 6 * 60 * 60 * 1000;

/**
 * Silence after which an in-flight upload discloses the stream ceiling.
 *
 * The console's own, with no wire source: the daemon enforces the ceiling and
 * says nothing about when a person should be told it exists. A minute — long
 * enough that a chunk round trip on a slow uplink is not called a stall, short
 * enough that a user learns the stream is bounded while there is still
 * time to act on it, which is why it has to sit far inside the ceiling itself.
 */
export const INGEST_STALL_DISCLOSURE_MS = 60_000;

/**
 * Bytes one `String.fromCharCode` call converts on the way to base64.
 *
 * Not a policy bound — a call-stack one. That function takes its bytes as
 * ARGUMENTS, so a spread of a whole chunk-capped slice overflows the stack on
 * every engine; eight kilobytes is comfortably inside the limit every one of
 * them documents while keeping the loop short enough that the rope it builds
 * costs nothing measurable.
 */
export const BASE64_ENCODE_STRIDE_BYTES: number = 8 * 1024;
