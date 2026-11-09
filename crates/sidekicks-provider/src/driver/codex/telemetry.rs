//! Codex's log export read for price: the tag each launch carries, which launch an export came
//! from, each completed response its records state, the responses a session's stream stated, the
//! exported responses a session holds until it can tell a stated one from a new one, where a
//! response on a thread no session streams belongs, the copies' threads, and the drain that takes
//! each response where it belongs.

use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) mod completed_response;
pub(crate) mod copy_threads;
pub(crate) mod drain;
pub(crate) mod exports;
pub(crate) mod held_responses;
pub(crate) mod placement;
mod reader;
pub(crate) mod streamed_responses;

/// Now in Unix milliseconds by the wall clock, the clock Codex stamps its records and reviews by;
/// zero for a clock set before 1970.
pub(crate) fn read_unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|since| u64::try_from(since.as_millis()).ok())
        .unwrap_or(0)
}
