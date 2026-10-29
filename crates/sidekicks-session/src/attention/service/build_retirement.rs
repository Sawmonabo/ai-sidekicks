//! The provider build retirement's slot: the one retirement armed on the wall clock's timer, which
//! fires across sleep, and the retry of a slot a refused timer or a failed retirement left empty,
//! a minute later on the monotonic clock and again each minute while it keeps failing.

use std::error::Error;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use jiff::Timestamp;
use sidekicks_std::failure_episode::FailureEpisode;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::{JobCondition, ScheduleError, ScheduledJobHandle};
use sidekicks_store::database::connection::read_pool::ReadLength;

use crate::attention::retention::next_provider_build_retirement;
use crate::attention::service::{AttentionService, AttentionServiceError};

/// The retirement's job name, as the program's log names it.
pub(super) const PROVIDER_BUILD_RETIREMENT_JOB: &str = "attention provider build retirement";

/// The retry's job name, as the program's log names it.
pub(super) const PROVIDER_BUILD_RETIREMENT_RETRY_JOB: &str =
    "attention provider build retirement retry";

/// How long an empty retirement slot waits before it is armed again: long enough that a system
/// that keeps refusing is read once a minute, never spun.
pub(super) const RETIREMENT_RETRY_DELAY: Duration = Duration::from_mins(1);

/// The provider build retirement the scheduler holds, and the retry of an emptied slot.
#[derive(Default)]
pub(super) struct RetirementSlot {
    armed: Option<ArmedRetirement>,
    // Numbers each arm, so a fired or refused retirement empties the slot only while it is its own.
    arms_made: u64,
    // At most one; a later failure replaces it and a successful arm cancels it.
    retry: Option<ScheduledJobHandle>,
    // Whether the slot failed since it was last armed, which logs later failures at debug.
    failures: FailureEpisode,
}

// A provider build line's retirement the scheduler holds, its arm's number and the instant it
// fires at.
struct ArmedRetirement {
    arm: u64,
    instant: SystemTime,
    job: ScheduledJobHandle,
}

impl RetirementSlot {
    /// The instant the armed retirement fires at, `None` while the slot is empty.
    #[cfg(test)]
    pub(super) fn armed_instant(&self) -> Option<SystemTime> {
        self.armed.as_ref().map(|armed| armed.instant)
    }
}

impl AttentionService {
    /// Arms the next provider build line's retirement on the wall clock's timer in place of the
    /// one armed, and cancels a pending retry once the slot holds what it should; a refused
    /// instant, or a failed read while the slot is empty, schedules the retry instead. Boxed, since
    /// a fired retirement's advance awaits it in turn.
    pub(super) fn arm_provider_build_retirement(self: &Arc<Self>) -> BoxFuture<'_, ()> {
        async move {
            let next = match self
                .pool
                .read(ReadLength::Short, |connection| {
                    Ok::<_, AttentionServiceError>(next_provider_build_retirement(connection)?)
                })
                .await
            {
                Ok(next) => next,
                Err(error) => {
                    self.retry_empty_retirement_slot(&error);
                    return;
                }
            };
            let mut slot = lock(&self.retirement);
            if slot.armed.as_ref().map(|armed| armed.instant) != next.map(SystemTime::from) {
                if let Some(previous) = slot.armed.take() {
                    previous.job.cancel();
                }
                if let Some(retires_at) = next
                    && let Err(error) =
                        self.schedule_provider_build_retirement(&mut slot, retires_at)
                {
                    self.schedule_retirement_retry(&mut slot, &error);
                    return;
                }
            }
            if let Some(retry) = slot.retry.take() {
                retry.cancel();
            }
            slot.failures.mark_succeeded();
        }
        .boxed()
    }

    // Schedules the retirement at `retires_at` into the empty `slot`, under the next arm's number,
    // and watches for the scheduler's later refusal of its instant, which empties the slot and
    // retries.
    fn schedule_provider_build_retirement(
        self: &Arc<Self>,
        slot: &mut RetirementSlot,
        retires_at: Timestamp,
    ) -> Result<(), ScheduleError> {
        let instant = SystemTime::from(retires_at);
        slot.arms_made += 1;
        let arm = slot.arms_made;
        let retiring = Arc::downgrade(self);
        let mut job = self.scheduler.schedule_at(
            PROVIDER_BUILD_RETIREMENT_JOB,
            JobCondition::Always,
            instant,
            move |_| {
                let retiring = retiring.clone();
                async move {
                    let Some(service) = retiring.upgrade() else {
                        return Ok(());
                    };
                    service.disarm_provider_build_retirement(arm);
                    if let Err(error) = service.advance_retention(Vec::new(), retires_at).await {
                        service.retry_empty_retirement_slot(&error);
                    }
                    Ok(())
                }
                .boxed()
            },
        )?;
        let refusal = job.refusal();
        slot.armed = Some(ArmedRetirement { arm, instant, job });
        let refused = Arc::downgrade(self);
        // Settles once the job runs, is canceled or is refused.
        tokio::spawn(async move {
            if let Some(error) = refusal.await
                && let Some(service) = refused.upgrade()
            {
                service.disarm_provider_build_retirement(arm);
                service.retry_empty_retirement_slot(&error);
            }
        });
        Ok(())
    }

    // Empties the retirement slot while it still holds arm number `arm`.
    fn disarm_provider_build_retirement(&self, arm: u64) {
        let mut slot = lock(&self.retirement);
        if slot.armed.as_ref().is_some_and(|armed| armed.arm == arm) {
            slot.armed = None;
        }
    }

    // Schedules the retry after `error` while the slot is empty; an armed slot needs none. The
    // first failure since the slot was last armed is logged at warn, later ones at debug.
    fn retry_empty_retirement_slot(self: &Arc<Self>, error: &(dyn Error + 'static)) {
        let mut slot = lock(&self.retirement);
        if slot.armed.is_none() {
            self.schedule_retirement_retry(&mut slot, error);
        } else if slot.failures.is_first_failure() {
            tracing::warn!(
                error,
                "a provider build's retirement could not be armed; the one armed stays"
            );
        } else {
            tracing::debug!(
                error,
                "a provider build's retirement still could not be armed; the one armed stays"
            );
        }
    }

    // Logs `error`, at warn the first time since the slot was last armed and at debug after, and
    // schedules one arm a minute from now on the monotonic clock in place of any pending.
    fn schedule_retirement_retry(
        self: &Arc<Self>,
        slot: &mut RetirementSlot,
        error: &(dyn Error + 'static),
    ) {
        if slot.failures.is_first_failure() {
            tracing::warn!(
                error,
                "a provider build's retirement could not be armed; it is tried again in a minute"
            );
        } else {
            tracing::debug!(
                error,
                "a provider build's retirement still could not be armed; it is tried again in a \
                 minute"
            );
        }
        if let Some(previous) = slot.retry.take() {
            previous.cancel();
        }
        let retrying = Arc::downgrade(self);
        let scheduled = self.scheduler.schedule(
            PROVIDER_BUILD_RETIREMENT_RETRY_JOB,
            JobCondition::Always,
            RETIREMENT_RETRY_DELAY,
            move |_| {
                let retrying = retrying.clone();
                async move {
                    if let Some(service) = retrying.upgrade() {
                        service.arm_provider_build_retirement().await;
                    }
                    Ok(())
                }
                .boxed()
            },
        );
        match scheduled {
            Ok(retry) => slot.retry = Some(retry),
            // Refused only once the scheduler stopped, with the daemon.
            Err(error) => tracing::debug!(
                error = &error as &(dyn Error + 'static),
                "a provider build's retirement retry was not scheduled"
            ),
        }
    }
}
