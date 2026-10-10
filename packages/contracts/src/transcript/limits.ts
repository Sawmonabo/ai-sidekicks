// The transcript's limits: the longest line of a row's text, the most rows a read or a search
// page holds, and the largest body that travels with its row. The transcript schemas are built
// from them; this module builds none, so code that only builds transcript pages loads no schema
// library.

/**
 * Cap on one line of a row's text: `TranscriptEventRowBase.summary`, the row's one-line summary,
 * and a transcript search's query and each hit's snippet. Larger than an identifier because it is
 * prose; a summary that needs more belongs in `payload`.
 */
export const TRANSCRIPT_EVENT_ROW_SUMMARY_MAX_LEN = 4096;

/**
 * Ceiling on a single `transcript.read` window, matching the package's other capped-count wire
 * members. It is a count ceiling, not a size one: `PAGE_MAX_BYTES` typically
 * trips first, since this many worst-case rows do not fit one frame.
 */
export const TRANSCRIPT_READ_LIMIT_MAX = 256;

/**
 * The most JSON bytes a row's body takes and still travels with its row on a read; a larger one
 * comes back as the `large` arm, which carries its size alone. Under `PAGE_MAX_BYTES` a page of
 * rows whose bodies all sit at this ceiling holds 29 of them when their other members are of
 * ordinary size, and 26 when every summary is at its limit in plain ASCII, so one huge output
 * never crowds its neighbors out of a page.
 */
export const TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES = 32_768;

/**
 * The most UTF-8 bytes a stored body holds and may still travel with its row: its JSON form adds
 * at least the two quotes, so a body over this is large without measuring its escapes.
 */
export const TRANSCRIPT_ROW_BODY_INLINE_MAX_UTF8_BYTES: number =
  TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES - 2;
