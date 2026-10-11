// The fixed bounds of the ingest stream protocol. None caps how large one file may be: the disk's
// free room, read at each stream's opening, does that.

/** The most ingest streams open at once; an opening past it is refused as transient. */
export const MAX_ACTIVE_INGEST_STREAMS = 16;

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
