//! One job held armed on the wall clock's timer for the next instant its owner names: armed again
//! in place whenever the instant moves, and, when the system refuses the timer, a read of what is
//! next fails or the job itself fails, tried again a minute later on the monotonic clock and again
//! each minute while it keeps failing.

use std::error::Error;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use futures::FutureExt as _;
use futures::future::BoxFuture;

use crate::failure_episode::FailureEpisode;
use crate::mutex_lock::lock;
use crate::scheduler::{JobCondition, ScheduleError, ScheduledJobHandle, Scheduler};

/// How long an empty job waits before it is armed again: long enough that a system that keeps
/// refusing is read once a minute, never spun.
pub const ARM_RETRY_DELAY: Duration = Duration::from_mins(1);

/// What owns an [`ArmedInstant`]: the work its instant runs and the read that arms it again.
pub trait InstantJob: Send + Sync + 'static {
    /// The armed instant the owner keeps.
    fn armed_instant(&self) -> &ArmedInstant;

    /// The work run once the wall clock reaches `instant`; a failure is retried a minute later
    /// through [`InstantJob::rearm`].
    fn fire(
        self: Arc<Self>,
        instant: SystemTime,
    ) -> BoxFuture<'static, Result<(), Box<dyn Error + Send + Sync>>>;

    /// Reads what is due next and arms it, the retry's work.
    fn rearm(self: Arc<Self>) -> BoxFuture<'static, ()>;
}

/// The one job its owner keeps armed on the wall clock, and the retry of a job left empty.
pub struct ArmedInstant {
    scheduler: Arc<Scheduler>,
    // The job's and its retry's names, as the program's log names them.
    job_name: &'static str,
    retry_job_name: &'static str,
    state: Mutex<ArmedState>,
}

#[derive(Default)]
struct ArmedState {
    armed: Option<ArmedJob>,
    // Numbers each arm, so a fired or refused job empties the slot only while it is its own.
    arms_made: u64,
    // At most one; a later failure replaces it and a successful arm cancels it.
    retry: Option<ScheduledJobHandle>,
    // Whether the job failed since it was last armed, which logs later failures at debug.
    failure_episode: FailureEpisode,
}

// The job the scheduler holds, its arm's number and the instant it fires at.
struct ArmedJob {
    arm: u64,
    instant: SystemTime,
    job: ScheduledJobHandle,
}

impl ArmedInstant {
    /// Nothing armed on `scheduler` yet; the job and its retry are named `job_name` and
    /// `retry_job_name` in the program's log.
    pub fn new(
        scheduler: Arc<Scheduler>,
        job_name: &'static str,
        retry_job_name: &'static str,
    ) -> Self {
        Self {
            scheduler,
            job_name,
            retry_job_name,
            state: Mutex::default(),
        }
    }

    /// The instant the armed job fires at, `None` while nothing is armed.
    #[cfg(any(test, feature = "test-support"))]
    pub fn instant(&self) -> Option<SystemTime> {
        lock(&self.state).armed.as_ref().map(|armed| armed.instant)
    }

    /// Arms `owner`'s job at `next` in place of the one armed, or cancels it for `None`, and
    /// cancels a pending retry once it holds what it should; a refused instant schedules the
    /// retry instead.
    pub fn arm<Owner: InstantJob>(owner: &Arc<Owner>, next: Option<SystemTime>) {
        let armed_instant = owner.armed_instant();
        let mut state = lock(&armed_instant.state);
        if state.armed.as_ref().map(|armed| armed.instant) != next {
            if let Some(previous) = state.armed.take() {
                previous.job.cancel();
            }
            if let Some(instant) = next
                && let Err(error) = schedule_job(owner, &mut state, instant)
            {
                armed_instant.log_failed_arm(&state.failure_episode, &error);
                schedule_retry(owner, &mut state);
                return;
            }
        }
        if let Some(retry) = state.retry.take() {
            retry.cancel();
        }
        state.failure_episode.mark_succeeded();
    }

    /// Schedules the retry after a failed read of what is next, `error`, while nothing is armed;
    /// an armed job needs none. The first failure since the job was last armed is logged at warn,
    /// later ones at debug.
    pub fn retry_while_empty<Owner: InstantJob>(owner: &Arc<Owner>, error: &(dyn Error + 'static)) {
        let armed_instant = owner.armed_instant();
        let mut state = lock(&armed_instant.state);
        if state.armed.is_none() {
            armed_instant.log_failed_arm(&state.failure_episode, error);
            schedule_retry(owner, &mut state);
        } else if state.failure_episode.is_first_failure() {
            tracing::warn!(
                job = armed_instant.job_name,
                error,
                "a timed job could not be armed; the one armed stays"
            );
        } else {
            tracing::debug!(
                job = armed_instant.job_name,
                error,
                "a timed job still could not be armed; the one armed stays"
            );
        }
    }

    /// Schedules the retry after a failure its owner logged itself, whatever is armed, in place of
    /// any pending: its rearm reads what is due again, so work an armed later instant would leave
    /// waiting runs a minute on.
    pub fn schedule_retry_after_failure<Owner: InstantJob>(owner: &Arc<Owner>) {
        schedule_retry(owner, &mut lock(&owner.armed_instant().state));
    }

    // Empties the slot while it still holds arm number `arm`.
    fn disarm(&self, arm: u64) {
        let mut state = lock(&self.state);
        if state.armed.as_ref().is_some_and(|armed| armed.arm == arm) {
            state.armed = None;
        }
    }

    // Logs a failed arm's `error`, at warn the first failure of `failure_episode` and at debug
    // after, before its retry is scheduled.
    fn log_failed_arm(&self, failure_episode: &FailureEpisode, error: &(dyn Error + 'static)) {
        if failure_episode.is_first_failure() {
            tracing::warn!(
                job = self.job_name,
                error,
                "a timed job could not be armed; it is tried again in a minute"
            );
        } else {
            tracing::debug!(
                job = self.job_name,
                error,
                "a timed job still could not be armed; it is tried again in a minute"
            );
        }
    }
}

// Schedules `owner`'s job at `instant` into the empty `state`, under the next arm's number, and
// watches for the scheduler's later refusal of its instant, which empties the slot and retries.
fn schedule_job<Owner: InstantJob>(
    owner: &Arc<Owner>,
    state: &mut ArmedState,
    instant: SystemTime,
) -> Result<(), ScheduleError> {
    let armed_instant = owner.armed_instant();
    state.arms_made += 1;
    let arm = state.arms_made;
    let firing = Arc::downgrade(owner);
    let mut job = armed_instant.scheduler.schedule_at(
        armed_instant.job_name,
        JobCondition::Always,
        instant,
        move |_| {
            let firing = firing.clone();
            async move {
                let Some(owner) = firing.upgrade() else {
                    return Ok(());
                };
                owner.armed_instant().disarm(arm);
                if let Err(error) = Arc::clone(&owner).fire(instant).await {
                    retry_failed_job(&owner, &*error);
                }
                Ok(())
            }
            .boxed()
        },
    )?;
    let refusal = job.refusal();
    state.armed = Some(ArmedJob { arm, instant, job });
    let refused = Arc::downgrade(owner);
    // Settles once the job runs, is canceled or is refused.
    tokio::spawn(async move {
        if let Some(error) = refusal.await
            && let Some(owner) = refused.upgrade()
        {
            owner.armed_instant().disarm(arm);
            ArmedInstant::retry_while_empty(&owner, &error);
        }
    });
    Ok(())
}

// Logs a fired job's failed `error`, at warn the first time since the job was last armed and at
// debug after, and schedules the retry, whose arm reads what is due again.
fn retry_failed_job<Owner: InstantJob>(owner: &Arc<Owner>, error: &(dyn Error + 'static)) {
    let armed_instant = owner.armed_instant();
    let mut state = lock(&armed_instant.state);
    if state.failure_episode.is_first_failure() {
        tracing::warn!(
            job = armed_instant.job_name,
            error,
            "a timed job failed; it is tried again in a minute"
        );
    } else {
        tracing::debug!(
            job = armed_instant.job_name,
            error,
            "a timed job still failed; it is tried again in a minute"
        );
    }
    schedule_retry(owner, &mut state);
}

// Schedules one rearm a minute from now on the monotonic clock in place of any pending.
fn schedule_retry<Owner: InstantJob>(owner: &Arc<Owner>, state: &mut ArmedState) {
    if let Some(previous) = state.retry.take() {
        previous.cancel();
    }
    let armed_instant = owner.armed_instant();
    let retrying = Arc::downgrade(owner);
    let scheduled = armed_instant.scheduler.schedule(
        armed_instant.retry_job_name,
        JobCondition::Always,
        ARM_RETRY_DELAY,
        move |_| {
            let retrying = retrying.clone();
            async move {
                if let Some(owner) = retrying.upgrade() {
                    owner.rearm().await;
                }
                Ok(())
            }
            .boxed()
        },
    );
    match scheduled {
        Ok(retry) => state.retry = Some(retry),
        // Refused only once the scheduler stopped, with the program.
        Err(error) => tracing::debug!(
            job = armed_instant.retry_job_name,
            error = &error as &(dyn Error + 'static),
            "a timed job's retry was not scheduled"
        ),
    }
}
