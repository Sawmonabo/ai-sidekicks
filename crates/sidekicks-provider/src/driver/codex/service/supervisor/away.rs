//! How long a service has been away, anything but up since it last was: a terminal joined to the
//! service retries for a window of its own and then never rejoins, so the time away says whether
//! that terminal gave up on it; and the watch a wait follows a service's comings and goings on.

use std::time::Duration;

use sidekicks_std::mutex_lock::lock;
use tokio::sync::watch;
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

    /// A watch on where the service stands, for a wait that reads the service between its
    /// changes: what it reads is marked seen, so a change made while a read runs is not missed.
    /// The caller holds the service for as long as it waits on the watch.
    pub(crate) fn watch_availability(&self) -> CodexAvailabilityWatch {
        CodexAvailabilityWatch {
            availability: self.availability.subscribe(),
        }
    }
}

/// Where a service a wait follows has come to rest.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CodexServiceRest {
    /// It runs and its connection is open.
    Up,
    /// It was shut down with the daemon, which may keep it running for the next start.
    ShutDown,
    /// It is down and nothing brings it back by itself: stopped, its ordinary start failed, or its
    /// restarts are spent in a crash loop.
    Down,
}

/// One wait's watch on a service's availability, held across the wait's reads; each wait on it
/// panics where the service was dropped, which the caller holding the service rules out.
pub(crate) struct CodexAvailabilityWatch {
    availability: watch::Receiver<CodexServiceAvailability>,
}

impl CodexAvailabilityWatch {
    /// Waits, however long it takes, until the service is no longer on its way back, and answers
    /// where it came to rest; a stop under way waits too, since it may still end in a start.
    pub(crate) async fn rest(&mut self) -> CodexServiceRest {
        let rested = self
            .availability
            .wait_for(|availability| {
                !availability.is_coming_back()
                    && !matches!(availability, CodexServiceAvailability::Stopping)
            })
            .await;
        match &*rested.expect("the service outlives its watch") {
            CodexServiceAvailability::Up => CodexServiceRest::Up,
            CodexServiceAvailability::ShutDown => CodexServiceRest::ShutDown,
            CodexServiceAvailability::Stopped
            | CodexServiceAvailability::StartFailed(_)
            | CodexServiceAvailability::CrashLoop => CodexServiceRest::Down,
            // The wait above passes none of these.
            CodexServiceAvailability::Starting
            | CodexServiceAvailability::Reconnecting
            | CodexServiceAvailability::Restarting
            | CodexServiceAvailability::Stopping => unreachable!("the service is at rest"),
        }
    }

    /// Waits for the service's next publish after the last one this watch read.
    pub(crate) async fn changed(&mut self) {
        self.availability
            .changed()
            .await
            .expect("the service outlives its watch");
    }
}
