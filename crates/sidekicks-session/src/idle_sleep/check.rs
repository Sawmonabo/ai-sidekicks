//! The idle sleep's check, a job on the program's scheduler every five minutes: each followed
//! session closed or deleted since is forgotten, and each awake one idle past the limit with
//! nothing holding it has its stop begun. Its reads are metered against its processor budget.

use std::error::Error;
use std::time::Duration;

use futures::FutureExt as _;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::budget::{BudgetTerm, JobBudget, JobWorkload, metered_job};
use sidekicks_std::scheduler::{JobCadence, JobCondition, ScheduleError, ScheduledJobHandle};
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::database::schema::session_directory::read_session_state;
use tokio::time::Instant;

use crate::idle_sleep::{IDLE_LIMIT, IdleSleepError, SessionIdleSleep, SessionSleep, SleepPhase};

/// How often the one check looks at every awake session.
const CHECK_INTERVAL: Duration = Duration::from_mins(5);

/// The check's name in the program's log.
const CHECK_JOB: &str = "idle sleep check";

/// The units the check's processor budget counts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CheckWorkUnit {
    /// Runs, one each, for the fixed work every check does.
    Runs,
    /// Sessions the check looked at.
    Sessions,
}

/// The check's processor budget on its own threads: 1 ms for the work every check does and
/// 200 µs per session it looks at, its state and hold reads.
const CHECK_BUDGET: JobBudget<CheckWorkUnit> = JobBudget::new(&[
    BudgetTerm {
        figure: Duration::from_millis(1),
        per: 1,
        unit: CheckWorkUnit::Runs,
    },
    BudgetTerm {
        figure: Duration::from_micros(200),
        per: 1,
        unit: CheckWorkUnit::Sessions,
    },
]);

impl SessionIdleSleep {
    /// Schedules the check every five minutes, metered against its budget. Fails when the
    /// scheduler refuses it.
    pub(super) fn schedule_check(&self) -> Result<ScheduledJobHandle, ScheduleError> {
        let checking = self.this.clone();
        self.deps.scheduler.schedule_job(
            CHECK_JOB,
            JobCondition::Always,
            JobCadence::Repeating {
                first_delay: CHECK_INTERVAL,
                interval: CHECK_INTERVAL,
            },
            metered_job(
                CHECK_BUDGET,
                Box::new(move |_stop| {
                    let checking = checking.clone();
                    async move {
                        let Some(idle_sleep) = checking.upgrade() else {
                            return Ok(None);
                        };
                        let sessions = idle_sleep.check().await;
                        let mut workload = JobWorkload::of(CheckWorkUnit::Runs, 1);
                        workload.add(
                            CheckWorkUnit::Sessions,
                            u64::try_from(sessions).unwrap_or(u64::MAX),
                        );
                        Ok(Some(workload))
                    }
                    .boxed()
                }),
            ),
        )
    }

    /// The check: every followed session closed or deleted since is forgotten, and each awake one
    /// idle past the limit with nothing holding it is stopped under its lock. A session whose
    /// check fails is written to the log and checked again next time. Answers how many sessions it
    /// looked at.
    pub(crate) async fn check(&self) -> usize {
        let now = Instant::now();
        let followed: Vec<SessionId> = lock(&self.sessions).keys().copied().collect();
        let looked_at = followed.len();
        for session_id in followed {
            if let Err(error) = self.check_session(session_id, now).await {
                tracing::warn!(
                    session_id = %session_id,
                    error = &error as &(dyn Error + 'static),
                    "the idle sleep could not check a session; its next check tries again"
                );
            }
        }
        looked_at
    }

    async fn check_session(
        &self,
        session_id: SessionId,
        now: Instant,
    ) -> Result<(), IdleSleepError> {
        let state = self
            .deps
            .pool
            .read(
                ReadLength::Short,
                move |reader| -> Result<_, IdleSleepError> {
                    Ok(read_session_state(reader, &session_id)?)
                },
            )
            .await?;
        match state {
            None | Some(SessionState::Closed | SessionState::PurgeRequested) => {
                return self.forget(session_id).await;
            }
            Some(SessionState::Provisioning | SessionState::Active | SessionState::Archived) => {}
        }
        if !self.is_awake_and_unheld(session_id) {
            return Ok(());
        }
        let driver = self.session_driver(session_id).await?;
        let holds = self.read_holds(driver.as_ref(), session_id).await?;
        self.keep_schedules(session_id, &holds.schedules).await;
        let is_due = {
            let mut sessions = lock(&self.sessions);
            match sessions.get_mut(&session_id) {
                Some(SessionSleep {
                    phase: SleepPhase::Awake { idle_since },
                    registered_holds: 0,
                    ..
                }) => {
                    if holds.is_held {
                        *idle_since = None;
                        false
                    } else {
                        now.duration_since(*idle_since.get_or_insert(now)) >= IDLE_LIMIT
                    }
                }
                Some(_) | None => false,
            }
        };
        if is_due {
            let idle_sleep = self.shared();
            self.transitions
                .spawn(async move { idle_sleep.stop_session(session_id).await });
        }
        Ok(())
    }
}
