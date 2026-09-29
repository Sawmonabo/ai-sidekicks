// The attachment ingest bounds, and the stride the encoder walks a chunk in.

// The three bounds below that are registered on the wire are enforced by the daemon; the
// console carries them so it can explain a bound ahead of the refusal rather than after
// it. Each mirrors its registered source EXACTLY and is never looser — a console that
// admitted more than the daemon would spend a user's upload to earn a refusal. All three
// are operator-tunable, so every surface that shows one says "default" until the daemon
// answers with the effective value. The chunk size is the contract's
// `ATTACHMENT_INGEST_CHUNK_MAX_BYTES`.

/**
 * Decoded bytes one attachment may carry, at the shipped default.
 *
 * `max_attachment_ingest_bytes`, deliberately equal to the per-artifact relay cap
 * so an accepted attachment is relay-pinnable by construction. Operator-tunable
 * between one megabyte and one gigabyte.
 */
export const ATTACHMENT_BYTE_CAP_DEFAULT: number = 100 * 1024 * 1024;

/**
 * Attachments one carrier may name, at the shipped default.
 *
 * `max_attachments_per_carrier`, derived from the quota envelope rather than
 * picked: one maximally-sized carrier exactly saturates the per-session relay
 * budget. Operator-tunable over a 1 – 50 range. Bound on the CARRIER and never on
 * an ingest stream, which carries exactly one payload and has no count to cap.
 */
export const ATTACHMENTS_PER_MESSAGE_CAP_DEFAULT = 10;

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
