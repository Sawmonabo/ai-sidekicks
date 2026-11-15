//! How long a service has been away, anything but up since it last was: a terminal joined to the
//! service retries for a window of its own and then never rejoins, so the time away says whether
//! that terminal gave up on it; and the watch a wait follows a service's comings and goings on,
//! with the reports that a service the daemon only joined answers nothing.

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

    /// Tells every wait on the service, one the daemon only joined, that it answered nothing.
    pub(super) fn publish_unanswered(&self) {
        self.unanswered
            .send_modify(|reports| *reports = reports.wrapping_add(1));
    }

    /// Tells every wait on the service again that it answers nothing, where its report count is
    /// still `reports`, the count a wait last read; a later report already told them.
    pub(crate) fn repeat_unanswered_report(&self, reports: u64) {
        self.unanswered.send_if_modified(|current| {
            let is_standing = *current == reports;
            if is_standing {
                *current = current.wrapping_add(1);
            }
            is_standing
        });
    }

    /// How many times the service was reported answering nothing.
    pub(crate) fn unanswered_reports(&self) -> u64 {
        *self.unanswered.borrow()
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

    /// A watch on where the service stands and on its reports of answering nothing, for a wait
    /// that reads the service between its changes: what it reads is marked seen, so a change made
    /// while a read runs is not missed, and a report made before the watch is not read. The caller
    /// holds the service for as long as it waits on the watch.
    pub(crate) fn watch_availability(&self) -> CodexAvailabilityWatch {
        let unanswered = self.unanswered.subscribe();
        let unanswered_read = *unanswered.borrow();
        CodexAvailabilityWatch {
            availability: self.availability.subscribe(),
            unanswered,
            unanswered_read,
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
    /// It is a service the daemon only joined, reported answering nothing since the watch last
    /// read it: up with a request unanswered, or redialed on a socket that listens and does not
    /// answer. Carries the report count read.
    Unanswered(u64),
}

/// One wait's watch on a service's availability and its reports of answering nothing, held across
/// the wait's reads; each wait on it panics where the service was dropped, which the caller
/// holding the service rules out.
pub(crate) struct CodexAvailabilityWatch {
    availability: watch::Receiver<CodexServiceAvailability>,
    unanswered: watch::Receiver<u64>,
    // The count of reports this watch last answered for.
    unanswered_read: u64,
}

impl CodexAvailabilityWatch {
    /// Waits, however long it takes, until the service is no longer on its way back or is
    /// reported answering nothing, and answers which; a stop under way waits too, since it may
    /// still end in a start.
    pub(crate) async fn rest(&mut self) -> CodexServiceRest {
        loop {
            let unanswered = *self.unanswered.borrow_and_update();
            if unanswered != self.unanswered_read {
                self.unanswered_read = unanswered;
                return CodexServiceRest::Unanswered(unanswered);
            }
            if let Some(rest) = read_rest(&self.availability.borrow_and_update()) {
                return rest;
            }
            self.changed().await;
        }
    }

    /// Whether the service reads up now, read without marking it seen.
    pub(crate) fn reads_up(&self) -> bool {
        matches!(*self.availability.borrow(), CodexServiceAvailability::Up)
    }

    /// The count of reports of answering nothing this watch last answered for.
    pub(crate) fn reports_read(&self) -> u64 {
        self.unanswered_read
    }

    /// Waits for the service's next publish, or its next report of answering nothing, after the
    /// last one this watch read.
    pub(crate) async fn changed(&mut self) {
        let changed = tokio::select! {
            changed = self.availability.changed() => changed,
            changed = self.unanswered.changed() => changed,
        };
        changed.expect("the service outlives its watch");
    }
}

// Where `availability` has come to rest; `None` while the service is on its way back or a stop
// under way may still end in a start.
fn read_rest(availability: &CodexServiceAvailability) -> Option<CodexServiceRest> {
    match availability {
        CodexServiceAvailability::Up => Some(CodexServiceRest::Up),
        CodexServiceAvailability::ShutDown => Some(CodexServiceRest::ShutDown),
        CodexServiceAvailability::Stopped
        | CodexServiceAvailability::StartFailed(_)
        | CodexServiceAvailability::CrashLoop => Some(CodexServiceRest::Down),
        CodexServiceAvailability::Starting
        | CodexServiceAvailability::Reconnecting
        | CodexServiceAvailability::Restarting
        | CodexServiceAvailability::Stopping => None,
    }
}
