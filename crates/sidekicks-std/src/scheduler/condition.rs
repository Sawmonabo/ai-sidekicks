//! When a due job may run: at once, or only while the busy count the scheduler was started with is
//! zero, and then at the latest at an instant on the wall clock, which keeps running while the
//! machine sleeps. A job whose condition fails is parked beside the queue, never holding the
//! scheduler's one task, and taken up when the busy count reaches zero or its latest instant
//! passes, whichever comes first; the count is followed, never polled.

use std::time::SystemTime;

use super::PendingRun;

/// When a due job may run, read against the busy count.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobCondition {
    /// Whenever it falls due.
    Always,
    /// Only while the busy count is zero.
    WhileIdle,
    /// While the busy count is zero, or once the wall clock reaches this instant, however busy.
    WhileIdleUntil(SystemTime),
}

impl JobCondition {
    /// Whether a job under this condition may run while the busy count is `busy`.
    pub(super) fn allows(self, busy: u32) -> bool {
        match self {
            Self::Always => true,
            Self::WhileIdle | Self::WhileIdleUntil(_) => busy == 0,
        }
    }

    // The instant a parked job runs however busy.
    fn latest(self) -> Option<SystemTime> {
        match self {
            Self::Always | Self::WhileIdle => None,
            Self::WhileIdleUntil(latest) => Some(latest),
        }
    }
}

/// The due runs whose condition failed when they fell due, in the order they were parked.
#[derive(Default)]
pub(super) struct ParkedRuns {
    runs: Vec<(Option<SystemTime>, PendingRun)>,
}

impl ParkedRuns {
    /// Parks `run`, whose condition failed when it fell due.
    pub(super) fn park(&mut self, run: PendingRun) {
        self.runs.push((run.condition.latest(), run));
    }

    /// The first parked run that may now go: any, once the busy count `busy` is zero, else the
    /// first whose latest instant the wall clock, read by `now` only while one has such an
    /// instant, has reached.
    pub(super) fn take_released(
        &mut self,
        busy: u32,
        now: impl FnOnce() -> SystemTime,
    ) -> Option<PendingRun> {
        let index = if busy == 0 {
            self.runs
                .iter()
                .position(|(_, run)| run.condition.allows(busy))
        } else {
            self.first_latest()?;
            let now = now();
            self.runs
                .iter()
                .position(|(latest, _)| latest.is_some_and(|latest| latest <= now))
        }?;
        Some(self.runs.remove(index).1)
    }

    /// The earliest instant a parked run goes however busy, which the wall clock's timer is armed
    /// for.
    pub(super) fn first_latest(&self) -> Option<SystemTime> {
        self.runs.iter().filter_map(|(latest, _)| *latest).min()
    }

    /// Lets the parked run with the earliest latest instant wait only for the busy count to reach
    /// zero, answering its job's name, as when the timer refuses that instant.
    pub(super) fn forget_first_latest(&mut self) -> &'static str {
        let first_latest = self.first_latest();
        let (latest, run) = self
            .runs
            .iter_mut()
            .find(|(latest, _)| *latest == first_latest)
            .expect("the first latest instant is a parked run's");
        *latest = None;
        run.name
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

    /// The names of the parked runs, in the order they were parked.
    #[cfg(any(test, feature = "test-support"))]
    pub(super) fn names(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.runs.iter().map(|(_, run)| run.name)
    }

    /// Takes every parked run out, for the stop to drop.
    pub(super) fn take_all(&mut self) -> Vec<(Option<SystemTime>, PendingRun)> {
        std::mem::take(&mut self.runs)
    }
}
