//! The fixed bounds of the ingest stream protocol. None caps how large one file may be: the disk's
//! free room, read at each stream's opening, does that.

use std::time::Duration;

/// The most uploads open at once, ingest streams and client publishes together; an admission past
/// it is refused as transient.
pub(crate) const MAX_ACTIVE_INGEST_STREAMS: usize = 16;

/// The most completed streams held to answer a resent completion; past it the oldest is let go, as
/// one past its lifetime is. Each holds only its saved result, a few hundred bytes.
pub(crate) const MAX_HELD_COMPLETIONS: usize = 64;

/// How long one stream may stay open from its opening. A trickle of chunks keeps a spool's
/// modified time young, so a stream's tenure needs a clock of its own.
pub(crate) const MAX_INGEST_STREAM_LIFETIME: Duration = Duration::from_hours(6);

/// How long a spool may go unwritten before the reaper deletes it; it clears the spools of streams
/// a stopped daemon left behind.
pub(crate) const ABANDONED_SPOOL_TTL: Duration = Duration::from_hours(48);
