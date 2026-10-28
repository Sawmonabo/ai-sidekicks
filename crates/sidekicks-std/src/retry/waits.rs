//! The program's one schedule of waits between the tries of a step that failed for a passing cause,
//! such as a reader holding the database busy; each wait doubles the one before.

use std::time::Duration;

const LONGEST_RETRY_WAIT: Duration = Duration::from_secs(32);

/// The waits before each retry: seven tries over 63 s. A step that must end gives up after the
/// last wait.
pub(crate) const RETRY_WAITS: [Duration; 6] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
    Duration::from_secs(8),
    Duration::from_secs(16),
    LONGEST_RETRY_WAIT,
];

/// The wait before the retry that follows `failed_tries` failures in a row, for a step that never
/// gives up: the schedule's, then its longest.
pub fn retry_wait(failed_tries: usize) -> Duration {
    RETRY_WAITS
        .get(failed_tries)
        .copied()
        .unwrap_or(LONGEST_RETRY_WAIT)
}
