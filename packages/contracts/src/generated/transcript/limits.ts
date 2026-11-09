// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The transcript's limits: the most rows a read or a search page holds.

/**
 * Ceiling on a single `transcript.read` window. It is a count ceiling, not a size one: the
 * page budget typically trips first, since this many worst-case rows do not fit one frame.
 */
export const TRANSCRIPT_READ_LIMIT_MAX = 256 as const;

/**
 * The longest query, and the longest snippet a hit carries, in code points: each is one line
 * of a row's text.
 */
export const TRANSCRIPT_SEARCH_TEXT_MAX_LEN = 4096 as const;

/**
 * The most JSON bytes a row's body takes and still travels with its row on a read; a larger
 * one comes back as the `large` arm, which carries its size alone.
 */
export const TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES = 32768 as const;
