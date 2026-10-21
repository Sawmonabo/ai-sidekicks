//! When a due job may run: at once, or only while no run is live, and then at the latest a bound
//! past its due time. A job whose condition fails is parked beside the queue, never holding the
//! scheduler's one task, and taken up when the count of live runs reaches zero or its bound
//! passes, whichever comes first; the count is followed, never polled.

use std::time::Duration;

use tokio::time::Instant;

use super::PendingRun;

/// When a due job may run, read against the count of live runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum JobCondition {
    /// Whenever it falls due.
    Always,
    /// Only while no run is live.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the repack job the daemon's start registers")
    )]
    NoTurnRunning,
    /// While no run is live, or once it has waited this long past its due time, whatever runs.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the daily backup the daemon's start registers")
    )]
    NoTurnRunningUntil(Duration),
}

impl JobCondition {
    /// Whether a job under this condition may run while `live_runs` runs are live.
    pub(super) fn allows(self, live_runs: u32) -> bool {
        match self {
            Self::Always => true,
            Self::NoTurnRunning | Self::NoTurnRunningUntil(_) => live_runs == 0,
        }
    }

    // The latest a job parked at `parked_at` waits before it runs whatever runs.
    fn latest(self, parked_at: Instant) -> Option<Instant> {
        match self {
            Self::Always | Self::NoTurnRunning => None,
            Self::NoTurnRunningUntil(bound) => Some(parked_at + bound),
        }
    }
}

/// The due runs whose condition failed when they fell due, in the order they were parked.
#[derive(Default)]
pub(super) struct ParkedRuns {
    runs: Vec<(Option<Instant>, PendingRun)>,
}

impl ParkedRuns {
    /// Parks `run`, which fell due at `now` while its condition failed.
    pub(super) fn park(&mut self, run: PendingRun, now: Instant) {
        self.runs.push((run.condition.latest(now), run));
    }

    /// The first parked run that may now go: any, once no run is live, else the first whose
    /// latest moment has passed.
    pub(super) fn take_released(&mut self, live_runs: u32, now: Instant) -> Option<PendingRun> {
        let index = self.runs.iter().position(|(latest, run)| {
            run.condition.allows(live_runs) || latest.is_some_and(|latest| latest <= now)
        })?;
        Some(self.runs.remove(index).1)
    }

    /// The earliest moment a parked run goes whatever runs, which the task sleeps until.
    pub(super) fn first_latest(&self) -> Option<Instant> {
        self.runs.iter().filter_map(|(latest, _)| *latest).min()
    }

    /// Whether no run is parked, so the count need not be followed.
    pub(super) fn is_empty(&self) -> bool {
        self.runs.is_empty()
    }

    /// Drops every parked run of the job `job_id`, answering whether one was parked.
    pub(super) fn cancel_job(&mut self, job_id: u64) -> bool {
        let parked_count = self.runs.len();
        self.runs.retain(|(_, run)| run.job_id != job_id);
        self.runs.len() < parked_count
    }

    /// Takes every parked run out, for the stop to drop.
    pub(super) fn take_all(&mut self) -> Vec<(Option<Instant>, PendingRun)> {
        std::mem::take(&mut self.runs)
    }
}
