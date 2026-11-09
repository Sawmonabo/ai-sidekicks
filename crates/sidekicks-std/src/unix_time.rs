//! The wall clock read as Unix milliseconds, the clock providers stamp their records and files by.

use std::time::{SystemTime, UNIX_EPOCH};

/// Now in Unix milliseconds by the wall clock; zero for a clock set before 1970.
#[must_use]
pub fn read_unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|since| u64::try_from(since.as_millis()).ok())
        .unwrap_or(0)
}
