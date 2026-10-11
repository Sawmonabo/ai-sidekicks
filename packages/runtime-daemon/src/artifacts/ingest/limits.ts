// The fixed bounds of the ingest stream protocol. None caps how large one file may be: the disk's
// free room, read at each stream's opening, does that.

/**
 * The most uploads open at once, ingest streams and client publishes together; an admission past
 * it is refused as transient.
 */
export const MAX_ACTIVE_INGEST_STREAMS = 16;

/**
 * The most completed streams held to answer a resent completion; past it the oldest is let go, as
 * one past its lifetime is. Each holds only its saved result, a few hundred bytes.
 */
export const MAX_HELD_COMPLETIONS = 64;

/**
 * How long one stream may stay open, in milliseconds from its opening: 6 hours. A trickle of
 * chunks keeps a spool's modified time young, so a stream's tenure needs a clock of its own.
 */
export const MAX_INGEST_STREAM_LIFETIME_MS: number = 6 * 60 * 60 * 1000;

/**
 * How long a spool may go unwritten before the reaper deletes it, in milliseconds since its last
 * write: 48 hours. It clears the spools of streams a stopped daemon left behind.
 */
export const ABANDONED_SPOOL_TTL_MS: number = 48 * 60 * 60 * 1000;
