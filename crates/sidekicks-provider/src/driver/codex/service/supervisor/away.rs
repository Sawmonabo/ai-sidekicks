//! How long a service has been away, anything but up since it last was: a terminal joined to the
//! service retries for a window of its own and then never rejoins, so the time away says whether
//! that terminal gave up on it; and whether a service away comes back up or is left down.

use std::time::Duration;

use sidekicks_std::mutex_lock::lock;
use tokio::time::Instant;

use super::CodexService;
use super::transition::CodexServiceAvailability;
use crate::driver::codex::terminal_session::TERMINAL_RECONNECT_WINDOW;

impl CodexService {
    /// Publishes where the service stands to every caller waiting on it, keeping since when it has
    /// been anything but up. A service back after an outage past the terminal's reconnect window
    /// forgets the terminal conversations it last listed, since every terminal then gave it up.
    pub(super) fn publish_availability(&self, availability: CodexServiceAvailability) {
        {
            let mut away_since = lock(&self.away_since);
            if matches!(availability, CodexServiceAvailability::Up) {
                if (*away_since).is_some_and(|since| since.elapsed() >= TERMINAL_RECONNECT_WINDOW) {
                    self.terminal_conversations().forget_listing();
                }
                *away_since = None;
            } else if away_since.is_none() {
                *away_since = Some(Instant::now());
            }
        }
        self.availability.send_replace(availability);
    }

    /// How long the service has been anything but up; `None` while it is up, and before anything
    /// was published for it.
    pub(crate) fn away_for(&self) -> Option<Duration> {
        lock(&self.away_since).as_ref().map(Instant::elapsed)
    }

    /// Answers once the service is up.
    pub(crate) async fn when_up(&self) {
        self.wait_for(|availability| matches!(availability, CodexServiceAvailability::Up))
            .await;
    }

    /// Answers whether the service came up, waiting for as long as it is on its way back however
    /// long that takes; `false` once it is left down for good: stopped, its start failed, its
    /// restarts spent in a crash loop, or shut down with the daemon.
    pub(crate) async fn comes_back_up(&self) -> bool {
        let mut availability = self.availability.subscribe();
        // A stop under way may still end in a start, so only where it ends counts.
        availability
            .wait_for(|availability| {
                !availability.is_coming_back()
                    && !matches!(availability, CodexServiceAvailability::Stopping)
            })
            .await
            .is_ok_and(|settled| matches!(*settled, CodexServiceAvailability::Up))
    }
}
