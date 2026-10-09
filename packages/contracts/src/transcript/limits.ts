// The transcript's limits: the longest row summary, the most rows a read or a search page holds,
// and the longest search text. The transcript schemas are built from them; this module builds
// none, so code that only builds transcript pages loads no schema library.

/**
 * Cap on `TranscriptEventRowBase.summary`, the row's one-line summary. Larger than an identifier
 * because it is prose; a summary that needs more belongs in `payload`.
 */
export const TRANSCRIPT_EVENT_ROW_SUMMARY_MAX_LEN = 4096;

/**
 * Ceiling on a single `transcript.read` window, matching the package's other capped-count wire
 * members. It is a count ceiling, not a size one: `PAGE_MAX_BYTES` typically
 * trips first, since this many worst-case rows do not fit one frame.
 */
export const TRANSCRIPT_READ_LIMIT_MAX = 256;

/**
 * The longest query, and the longest snippet a hit carries: each is one line of
 * a row's text, the same measure as a row's one-line summary, under the search's own name.
 *
 * @alias
 */
export const TRANSCRIPT_SEARCH_TEXT_MAX_LEN: number = TRANSCRIPT_EVENT_ROW_SUMMARY_MAX_LEN;
