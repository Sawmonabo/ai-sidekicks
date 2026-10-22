//! The daily run: due at the first moment of each local day, from its midnight, with no run live,
//! and at the latest 25 hours after the last run ended. Both moments are wall-clock instants, so
//! sleep does not hold the run back; each daily run schedules the next.

use std::error::Error;
use std::sync::{Arc, PoisonError, Weak};
use std::time::{Duration, SystemTime};

use futures::FutureExt as _;
use jiff::Timestamp;
use jiff::tz::TimeZone;

use super::{BACKUP_BUDGET, BackupTrigger, Backups, last_finished_at};
use crate::daemon::scheduler::budget::metered_job;
use crate::daemon::scheduler::{JobCondition, ScheduleError, Scheduler};

// How long after the last run ended the daily run goes whatever runs.
const DAILY_LATEST_AFTER: Duration = Duration::from_hours(25);

// When a daily run falls due, and the moment it goes whatever runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DailyCadence {
    due: SystemTime,
    latest: SystemTime,
}

impl Backups {
    /// Schedules the daily run at the first local midnight after the last run ended, or at once
    /// before the first, with no run live and at the latest 25 hours after that run; each daily
    /// run schedules the next. Fails when the last run does not read or the scheduler refuses the
    /// run.
    #[expect(dead_code, reason = "the daemon's start schedules the daily backup")]
    pub(crate) async fn schedule_daily(
        self: &Arc<Self>,
        scheduler: &Arc<Scheduler>,
    ) -> Result<(), Box<dyn Error + Send + Sync>> {
        let last_finished = self
            .read_last_run()
            .await?
            .and_then(|last_run| last_finished_at(&last_run));
        let cadence = daily_cadence(last_finished, SystemTime::now(), &TimeZone::system());
        schedule_daily_at(
            Arc::clone(self),
            Arc::downgrade(scheduler),
            scheduler,
            cadence,
        )?;
        Ok(())
    }
}

// The daily run after one that ended at `last_finished`, on the local day of `time_zone`: due at
// the next midnight, and going at the latest 25 hours after; with no run yet, due and going now.
fn daily_cadence(
    last_finished: Option<SystemTime>,
    now: SystemTime,
    time_zone: &TimeZone,
) -> DailyCadence {
    let Some(finished) = last_finished else {
        return DailyCadence {
            due: now,
            latest: now,
        };
    };
    let latest = finished + DAILY_LATEST_AFTER;
    let due = next_midnight(finished, time_zone).map_or(latest, |midnight| midnight.min(latest));
    DailyCadence { due, latest }
}

// The first moment of the local day after the one holding `after`; `None` past jiff's range.
fn next_midnight(after: SystemTime, time_zone: &TimeZone) -> Option<SystemTime> {
    let day = Timestamp::try_from(after).ok()?.to_zoned(time_zone.clone());
    Some(SystemTime::from(day.tomorrow().ok()?.start_of_day().ok()?))
}

// Schedules the daily run at `cadence`, metered against the backup's budget; the run skips while
// another run is queued or running, which copies for it, and schedules the next from its end.
fn schedule_daily_at(
    backups: Arc<Backups>,
    scheduler_handle: Weak<Scheduler>,
    scheduler: &Scheduler,
    cadence: DailyCadence,
) -> Result<(), ScheduleError> {
    let job = metered_job(
        BACKUP_BUDGET,
        Box::new(move |stop, meter| {
            let backups = Arc::clone(&backups);
            let scheduler_handle = scheduler_handle.clone();
            async move {
                // Taken under one lock with the check, so a request joins this run from here on.
                let is_queued = {
                    let mut pending = backups
                        .pending
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner);
                    let is_queued = pending.is_some();
                    if !is_queued {
                        *pending = Some(BackupTrigger::Daily);
                    }
                    is_queued
                };
                let ran = if is_queued {
                    Ok(None)
                } else {
                    // A request that joined since keeps its stronger trigger.
                    let trigger = backups
                        .pending
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .unwrap_or(BackupTrigger::Daily);
                    let ran = backups.run(trigger, &stop, &meter).await;
                    *backups
                        .pending
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner) = None;
                    ran
                };
                if let Some(scheduler) = scheduler_handle.upgrade() {
                    let now = SystemTime::now();
                    let next = daily_cadence(Some(now), now, &TimeZone::system());
                    schedule_daily_at(Arc::clone(&backups), scheduler_handle, &scheduler, next)?;
                }
                ran
            }
            .boxed()
        }),
    );
    scheduler
        .schedule_at(
            "daily backup",
            JobCondition::NoTurnRunningUntil(cadence.latest),
            cadence.due,
            job,
        )
        .map(drop)
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, SystemTime};

    use jiff::Timestamp;
    use jiff::tz::{TimeZone, offset};

    use super::{DailyCadence, daily_cadence};

    fn instant(text: &str) -> SystemTime {
        SystemTime::from(text.parse::<Timestamp>().expect("an instant"))
    }

    // The daily run falls due at the first local midnight after the last run, however late in
    // its day that run ended, and goes at the latest 25 hours after it; before the first run it is
    // due at once. Killed by a due time a day after the last run, by a midnight read in UTC
    // rather than the local zone, and by a latest moment that is not the last run's.
    #[test]
    fn the_daily_run_falls_due_at_the_next_local_midnight() {
        let eastern = offset(-4).to_time_zone();
        let now = instant("2026-10-21T12:00:00Z");
        assert_eq!(
            daily_cadence(Some(instant("2026-10-20T19:00:00Z")), now, &eastern),
            DailyCadence {
                due: instant("2026-10-21T04:00:00Z"),
                latest: instant("2026-10-21T20:00:00Z"),
            }
        );
        assert_eq!(
            daily_cadence(Some(instant("2026-10-21T03:30:00Z")), now, &eastern).due,
            instant("2026-10-21T04:00:00Z")
        );
        assert_eq!(
            daily_cadence(None, now, &TimeZone::UTC),
            DailyCadence {
                due: now,
                latest: now,
            }
        );
        assert_eq!(
            daily_cadence(Some(now), now, &TimeZone::UTC)
                .latest
                .duration_since(now)
                .expect("the latest moment is after the run"),
            Duration::from_hours(25)
        );
    }
}
