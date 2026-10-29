//! Each observed account's own repeating job on the daemon's scheduler: due every five minutes,
//! the first delays of accounts started together spread across those minutes, and a job restarted
//! by a read taken outside it, so its next run comes a whole interval after that read.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::{JobCondition, ScheduleError, ScheduledJobHandle, Scheduler};

/// How often an account is read.
pub(super) const OBSERVATION_INTERVAL: Duration = Duration::from_mins(5);

const OBSERVATION_JOB: &str = "provider account observation";

/// What a due job calls with its account; it starts the read and returns at once, so a read never
/// holds the scheduler's one task.
pub(super) type ObservationDue = Arc<dyn Fn(ProviderAccountId) + Send + Sync>;

/// The observed accounts' jobs, one per account.
pub(super) struct ObservationSchedule {
    scheduler: Arc<Scheduler>,
    on_due: ObservationDue,
    jobs: Mutex<HashMap<ProviderAccountId, ScheduledJobHandle>>,
}

impl ObservationSchedule {
    /// Jobs on `scheduler` that call `on_due`.
    pub(super) fn new(scheduler: Arc<Scheduler>, on_due: ObservationDue) -> Self {
        Self {
            scheduler,
            on_due,
            jobs: Mutex::default(),
        }
    }

    /// The first delays of `count` accounts started together, spread evenly across one interval.
    pub(super) fn spread_first_delays(count: usize) -> impl Iterator<Item = Duration> {
        let slots = u32::try_from(count.max(1)).unwrap_or(u32::MAX);
        (0..slots).map(move |slot| OBSERVATION_INTERVAL * slot / slots)
    }

    /// Schedules `account_id`'s job `first_delay` from now, in place of any it had. Refused once
    /// the scheduler has stopped.
    pub(super) fn watch(
        &self,
        account_id: ProviderAccountId,
        first_delay: Duration,
    ) -> Result<(), ScheduleError> {
        let on_due = Arc::clone(&self.on_due);
        let due_account = account_id.clone();
        let job = self.scheduler.schedule_repeating(
            OBSERVATION_JOB,
            JobCondition::Always,
            OBSERVATION_INTERVAL,
            first_delay,
            move |_| {
                on_due(due_account.clone());
                async { Ok(()) }.boxed()
            },
        )?;
        if let Some(replaced) = lock(&self.jobs).insert(account_id, job) {
            replaced.cancel();
        }
        Ok(())
    }

    /// Starts `account_id`'s interval again from now, where it is watched. Refused once the
    /// scheduler has stopped.
    pub(super) fn restart(&self, account_id: &ProviderAccountId) -> Result<(), ScheduleError> {
        if lock(&self.jobs).contains_key(account_id) {
            self.watch(account_id.clone(), OBSERVATION_INTERVAL)?;
        }
        Ok(())
    }

    /// Removes `account_id`'s job.
    pub(super) fn forget(&self, account_id: &ProviderAccountId) {
        if let Some(job) = lock(&self.jobs).remove(account_id) {
            job.cancel();
        }
    }

    /// Removes every job.
    pub(super) fn forget_all(&self) {
        for (_, job) in lock(&self.jobs).drain() {
            job.cancel();
        }
    }
}
