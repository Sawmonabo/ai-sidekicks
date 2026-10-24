//! When a due job may run: at once, or only while no run is live, and then at the latest at an
//! instant on the wall clock, which keeps running while the machine sleeps. A job whose condition
//! fails is parked beside the queue, never holding the scheduler's one task, and taken up when the
//! count of live runs reaches zero or its latest instant passes, whichever comes first; the count
//! is followed, never polled.

use std::time::SystemTime;

use super::PendingRun;

/// When a due job may run, read against the count of live runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum JobCondition {
    /// Whenever it falls due.
    Always,
    /// Only while no run is live.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the repack `Delete old data` schedules")
    )]
    NoTurnRunning,
    /// While no run is live, or once the wall clock reaches this instant, whatever runs.
    NoTurnRunningUntil(SystemTime),
}

impl JobCondition {
    /// Whether a job under this condition may run while `live_runs` runs are live.
    pub(super) fn allows(self, live_runs: u32) -> bool {
        match self {
            Self::Always => true,
            Self::NoTurnRunning | Self::NoTurnRunningUntil(_) => live_runs == 0,
        }
    }

    // The instant a parked job runs whatever runs.
    fn latest(self) -> Option<SystemTime> {
        match self {
            Self::Always | Self::NoTurnRunning => None,
            Self::NoTurnRunningUntil(latest) => Some(latest),
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

    /// The first parked run that may now go: any, once no run is live, else the first whose
    /// latest instant the wall clock, read by `now` only while one has such an instant, has
    /// reached.
    pub(super) fn take_released(
        &mut self,
        live_runs: u32,
        now: impl FnOnce() -> SystemTime,
    ) -> Option<PendingRun> {
        let index = if live_runs == 0 {
            self.runs
                .iter()
                .position(|(_, run)| run.condition.allows(live_runs))
        } else {
            self.first_latest()?;
            let now = now();
            self.runs
                .iter()
                .position(|(latest, _)| latest.is_some_and(|latest| latest <= now))
        }?;
        Some(self.runs.remove(index).1)
    }

    /// The earliest instant a parked run goes whatever runs, which the wall clock's timer is armed
    /// for.
    pub(super) fn first_latest(&self) -> Option<SystemTime> {
        self.runs.iter().filter_map(|(latest, _)| *latest).min()
    }

    /// Lets the parked run with the earliest latest instant wait for no run to be live only,
    /// answering its job's name, as when the timer refuses that instant.
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
    #[cfg(test)]
    pub(super) fn names(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.runs.iter().map(|(_, run)| run.name)
    }

    /// Takes every parked run out, for the stop to drop.
    pub(super) fn take_all(&mut self) -> Vec<(Option<SystemTime>, PendingRun)> {
        std::mem::take(&mut self.runs)
    }
}
