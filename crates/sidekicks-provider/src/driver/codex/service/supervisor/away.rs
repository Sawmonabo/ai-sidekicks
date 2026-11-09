//! How long a service has been away, anything but up since it last was: a terminal joined to the
//! service retries for a window of its own and then never rejoins, so the time away says whether
//! that terminal gave up on it.

use std::time::Duration;

use sidekicks_std::mutex_lock::lock;
use tokio::time::Instant;

use super::CodexService;
use super::transition::CodexServiceAvailability;

impl CodexService {
    /// Publishes where the service stands to every caller waiting on it, keeping since when it has
    /// been anything but up.
    pub(super) fn publish_availability(&self, availability: CodexServiceAvailability) {
        {
            let mut away_since = lock(&self.away_since);
            if matches!(availability, CodexServiceAvailability::Up) {
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
}
