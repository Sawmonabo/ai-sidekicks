//! The daemon's one sliding window over a process's recent crashes: how long to wait before each
//! restart, and when the crashes come too close together to restart at all.

use std::collections::VecDeque;
use std::time::{Duration, SystemTime};

/// How long a provider process waits before each automatic restart, indexed by how many crashes the
/// three-minute window already holds. A crash past the list's end, the fifth, ends the restarts.
const PROVIDER_RESTART_WAITS: &[Duration] = &[
    Duration::ZERO,
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
];

// The span the provider's crashes are counted over.
const PROVIDER_CRASH_WINDOW: Duration = Duration::from_mins(3);

/// What a recorded crash answers: the wait before the restart, or a crash loop that ends the
/// restarts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CrashOutcome {
    /// Restart once this wait has passed.
    RestartAfter(Duration),
    /// The window already held one crash per wait, so no restart follows.
    CrashLoop,
}

/// The crashes of one process over a sliding window, on the wall clock, which keeps running while
/// the machine sleeps. It holds at most one entry per wait.
#[derive(Debug)]
pub(crate) struct CrashWindow {
    window: Duration,
    restart_waits: &'static [Duration],
    // Crash times in the order they were recorded, oldest first.
    crash_times: VecDeque<SystemTime>,
}

impl CrashWindow {
    /// The provider's window: three minutes over its four waits.
    pub(crate) fn provider() -> Self {
        Self::new(PROVIDER_CRASH_WINDOW, PROVIDER_RESTART_WAITS)
    }

    /// A window over `window` that answers `restart_waits`, indexed by the crashes it already
    /// holds.
    pub(crate) fn new(window: Duration, restart_waits: &'static [Duration]) -> Self {
        Self {
            window,
            restart_waits,
            crash_times: VecDeque::with_capacity(restart_waits.len()),
        }
    }

    /// Records a crash at `at` and answers the wait before restarting, or a crash loop when the
    /// window already held one crash per wait. A crash at least the window older than `at` no
    /// longer counts.
    pub(crate) fn record_crash(&mut self, at: SystemTime) -> CrashOutcome {
        while let Some(&oldest) = self.crash_times.front() {
            // A crash recorded later than `at`, by a clock set back, still counts.
            if at
                .duration_since(oldest)
                .is_ok_and(|age| age >= self.window)
            {
                self.crash_times.pop_front();
            } else {
                break;
            }
        }
        let Some(&restart_after) = self.restart_waits.get(self.crash_times.len()) else {
            return CrashOutcome::CrashLoop;
        };
        self.crash_times.push_back(at);
        CrashOutcome::RestartAfter(restart_after)
    }

    /// Forgets every crash, so the next one counts from the first; a person's restart does this.
    pub(crate) fn clear(&mut self) {
        self.crash_times.clear();
    }
}
