//! The idle sleep: one daemon-wide check every five minutes stops the process of a session idle for
//! thirty minutes with nothing holding it, deciding again under the session's transition lock, and
//! a message to a sleeping session wakes it first. What sleeps, and how, is the session's driver's:
//! a provider whose sessions never sleep answers no holds and stays awake. A recurring job the
//! provider keeps lets the session sleep and wakes it two minutes before each run, through the
//! program's scheduler on the wall clock; the kept jobs and wake-ups are stored, so the daemon's
//! next start wakes each session on its schedule and leaves every other session asleep.
//!
//! The run queue's provider sessions, the one place a session's process opens, tell the idle sleep
//! of each opening and close, and a sleeping session is brought up through them.
//!
//! A session's place: awake (its idle clock running once nothing holds it), stopping (under its
//! transition lock), asleep, or waking (one resume). A wake trigger while stopping is kept and
//! wakes the session once its process exited; triggers while waking join the one resume and are
//! answered in arrival order, each failed when the resume fails, which leaves the session asleep.

mod holds;
pub mod kept_schedules;
pub mod openings;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::error::Error;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, SystemTime};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use jiff::Timestamp;
use jiff::tz::TimeZone;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_provider::command::running_set::RunningCommandSets;
use sidekicks_provider::driver::contract::{DriverError, ProviderDriver};
use sidekicks_provider::driver::idle_sleep::{KeptSchedule, SessionSleepState};
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::port::session_wake::SessionWaker;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::{JobCondition, ScheduleError, ScheduledJobHandle, Scheduler};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::schema::session_directory::read_session_state_through;
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};
use sidekicks_store::events::session::read::DamagedFromSequenceReader;
use tokio::sync::{SetOnce, SetOnceError, oneshot};
use tokio::time::Instant;
use tokio_util::task::TaskTracker;

use crate::driver_resolution::read_session_driver;
use crate::idle_sleep::holds::{HoldSources, SessionHolds, read_session_holds};
use crate::idle_sleep::kept_schedules::{
    delete_schedules_statement, next_wake_at, read_stored_schedules, replace_schedules_statements,
};
use crate::idle_sleep::openings::{SessionProcessFollower, SessionProcessWaker};

/// The statements the idle sleep prepares on a pooled connection: a session's live runs, its
/// waiting messages, its state, its lead's binding, and every session's kept schedules.
pub const IDLE_SLEEP_STATEMENT_CAPACITY: usize = 5;

/// How often the one check looks at every awake session.
const CHECK_INTERVAL: Duration = Duration::from_mins(5);

/// How long a session stays idle, nothing holding it, before its process is stopped.
const IDLE_LIMIT: Duration = Duration::from_mins(30);

/// The check's name in the program's log.
const CHECK_JOB: &str = "idle sleep check";

/// A scheduled wake's name in the program's log.
const SCHEDULED_WAKE_JOB: &str = "idle sleep scheduled wake";

/// Why the idle sleep could not read, stop or wake a session.
#[derive(Debug, thiserror::Error)]
pub enum IdleSleepError {
    /// The session is not one this daemon holds (`session.notFound`), or no registered driver
    /// answers its provider (`provider.notFound`).
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// SQLite refused a read of a hold or of the kept schedules, or a stored value did not read.
    #[error("a read of the idle sleep's holds or kept schedules failed")]
    Database(#[from] rusqlite::Error),
    /// The read pool did not run the read.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// The kept schedules were not stored.
    #[error("the idle sleep's kept schedules were not stored")]
    Write(#[from] WriteError),
    /// The session's driver failed a read of its holds, its stop or its resume.
    #[error(transparent)]
    Driver(#[from] DriverError),
    /// The place a session's process opens failed to bring it up: the session closed or is being
    /// deleted, or its driver's wake or resume failed.
    #[error("the process of session {session_id} was not brought up")]
    ProcessNotWoken {
        /// The session.
        session_id: SessionId,
        /// Why.
        #[source]
        cause: Box<dyn Error + Send + Sync>,
    },
    /// The driver answered the session's wake with the session still asleep.
    #[error("the provider left session {session_id} asleep at its wake")]
    NotWoken {
        /// The session.
        session_id: SessionId,
    },
    /// The daemon stopped, or never handed the idle sleep the place a process opens, before the
    /// session's wake ended.
    #[error("the daemon stopped before the wake of session {session_id} ended")]
    WakeAbandoned {
        /// The session.
        session_id: SessionId,
    },
    /// The program's scheduler refused the check.
    #[error(transparent)]
    Schedule(#[from] ScheduleError),
}

/// What the idle sleep reads and acts through.
pub struct SessionIdleSleepDeps {
    /// The read pool the holds, the sessions' states and the kept schedules are read on.
    pub pool: Arc<DatabaseReadPool>,
    /// The writer the kept schedules are stored through.
    pub writer: Arc<DatabaseWriter>,
    /// The drivers a session's holds, stop and wake go through.
    pub providers: Arc<ProviderRegistry>,
    /// Where each session's log is damaged from, so its binding is read from the part before.
    pub read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
    /// The session-wide transition lock the stop holds.
    pub transition_lock: Arc<KeyedLock<SessionId>>,
    /// The sessions' running commands, each a hold.
    pub running_commands: Arc<RunningCommandSets>,
    /// The program's scheduler, which runs the check and each session's scheduled wake.
    pub scheduler: Arc<Scheduler>,
}

/// The daemon's one idle sleep; see the module doc. It is the sessions' [`SessionWaker`].
pub struct SessionIdleSleep {
    deps: SessionIdleSleepDeps,
    // Each session the idle sleep follows: every session woken or held in this daemon's life, and
    // every one with a stored schedule, until it is closed or deleted.
    sessions: Mutex<HashMap<SessionId, SessionSleep>>,
    // The place a sleeping session's process is brought up, handed once while the daemon wires its
    // services; it holds the idle sleep, so the idle sleep holds it weakly.
    process_waker: SetOnce<Weak<dyn SessionProcessWaker>>,
    // Every stop and resume under way, which the daemon's stop waits for.
    transitions: TaskTracker,
    check_job: Mutex<Option<ScheduledJobHandle>>,
    this: Weak<SessionIdleSleep>,
}

/// What a kept trigger is answered with: its session woke, or why it did not.
type WakeOutcome = Result<(), Arc<IdleSleepError>>;

// One session as the idle sleep follows it.
struct SessionSleep {
    phase: SleepPhase,
    // The holds the daemon's own parts took, each a `SleepHold`.
    registered_holds: usize,
    // The wake armed for the session's next timed fire while it sleeps.
    armed_wake: Option<ScheduledJobHandle>,
    // The timed fires last read for the session, which its armed wake follows.
    kept_schedules: Vec<KeptSchedule>,
    // Whether `kept_schedules` is what is stored; a failed write leaves it for the next check.
    are_schedules_stored: bool,
    // Whether a failed store of the session's timed fires was written to the log since the last
    // store that went through, so a failure repeated at each check is logged once.
    is_store_failure_logged: bool,
}

enum SleepPhase {
    // Its process is up; the idle clock runs from when its last hold was seen to end.
    Awake {
        idle_since: Option<Instant>,
    },
    // Its process is being stopped under the transition lock; each trigger waits for the exit.
    Stopping {
        kept: Vec<oneshot::Sender<WakeOutcome>>,
    },
    // Its process is stopped, or its state is unknown to this daemon, which a wake asks the driver.
    Asleep,
    // Its one resume is under way; each trigger waits for it, in arrival order.
    Waking {
        kept: Vec<oneshot::Sender<WakeOutcome>>,
    },
}

// How a stop under the lock ended.
enum StopOutcome {
    Asleep,
    Held,
    NeverSleeps,
}

impl SessionSleep {
    // A session whose state this daemon does not know: a wake asks its driver.
    fn unknown() -> Self {
        Self {
            phase: SleepPhase::Asleep,
            registered_holds: 0,
            armed_wake: None,
            kept_schedules: Vec::new(),
            are_schedules_stored: true,
            is_store_failure_logged: false,
        }
    }
}

/// A hold a part of the daemon keeps on a session's process, a voice call's: while it lives the
/// session never sleeps, and its drop starts the session's idle clock.
pub struct SleepHold {
    idle_sleep: Weak<SessionIdleSleep>,
    session_id: SessionId,
}

impl Drop for SleepHold {
    fn drop(&mut self) {
        let Some(idle_sleep) = self.idle_sleep.upgrade() else {
            return;
        };
        let mut sessions = lock(&idle_sleep.sessions);
        if let Some(entry) = sessions.get_mut(&self.session_id) {
            entry.registered_holds = entry.registered_holds.saturating_sub(1);
            if entry.registered_holds == 0
                && let SleepPhase::Awake { idle_since } = &mut entry.phase
            {
                *idle_since = Some(Instant::now());
            }
        }
    }
}

impl SessionIdleSleep {
    /// The idle sleep over `deps`; [`SessionIdleSleep::start`] restores the kept schedules and
    /// starts the check.
    pub fn new(deps: SessionIdleSleepDeps) -> Arc<Self> {
        Arc::new_cyclic(|this| Self {
            deps,
            sessions: Mutex::new(HashMap::new()),
            process_waker: SetOnce::new(),
            transitions: TaskTracker::new(),
            check_job: Mutex::new(None),
            this: this.clone(),
        })
    }

    /// Hands the idle sleep the place a sleeping session's process is brought up, once, while the
    /// daemon wires its services and before the idle sleep starts. Fails with the handle when one
    /// was handed already.
    pub fn set_process_waker(
        &self,
        waker: Weak<dyn SessionProcessWaker>,
    ) -> Result<(), SetOnceError<Weak<dyn SessionProcessWaker>>> {
        self.process_waker.set(waker)
    }

    /// Arms a wake for each stored schedule, every session it names counted asleep, and schedules
    /// the check every five minutes. Fails when the stored schedules do not read or the scheduler
    /// refuses the check.
    pub async fn start(&self) -> Result<(), IdleSleepError> {
        let stored = self
            .deps
            .pool
            .read(ReadLength::Short, |reader| -> Result<_, IdleSleepError> {
                Ok(read_stored_schedules(reader)?)
            })
            .await?;
        {
            let mut sessions = lock(&self.sessions);
            for (session_id, schedule) in stored {
                sessions
                    .entry(session_id)
                    .or_insert_with(SessionSleep::unknown)
                    .kept_schedules
                    .push(schedule);
            }
            for (session_id, entry) in sessions.iter_mut() {
                self.arm_wake(*session_id, entry);
            }
        }
        let checking = self.this.clone();
        let job = self.deps.scheduler.schedule_repeating(
            CHECK_JOB,
            JobCondition::Always,
            CHECK_INTERVAL,
            CHECK_INTERVAL,
            move |_| {
                let checking = checking.clone();
                async move {
                    if let Some(idle_sleep) = checking.upgrade() {
                        idle_sleep.check().await;
                    }
                    Ok(())
                }
                .boxed()
            },
        )?;
        *lock(&self.check_job) = Some(job);
        Ok(())
    }

    /// Stops checking and waking on schedule, then waits for every stop and resume under way: a
    /// stop in progress ends with its process's exit, a resume once its process is up or failed.
    pub async fn stop(&self) {
        if let Some(job) = lock(&self.check_job).take() {
            job.cancel();
        }
        for entry in lock(&self.sessions).values_mut() {
            if let Some(armed) = entry.armed_wake.take() {
                armed.cancel();
            }
        }
        self.transitions.close();
        self.transitions.wait().await;
    }

    /// Holds `session_id`'s process up until the returned hold drops, waking the session first
    /// when it sleeps. Fails as the wake fails, holding nothing.
    pub async fn hold(&self, session_id: SessionId) -> Result<SleepHold, Arc<IdleSleepError>> {
        lock(&self.sessions)
            .entry(session_id)
            .or_insert_with(SessionSleep::unknown)
            .registered_holds += 1;
        let hold = SleepHold {
            idle_sleep: self.this.clone(),
            session_id,
        };
        self.wake(session_id).await?;
        Ok(hold)
    }

    // The idle sleep's own allocation, which outlives every call made on it.
    fn shared(&self) -> Arc<Self> {
        self.this
            .upgrade()
            .expect("the idle sleep lives in its allocation while a call runs on it")
    }

    // Answers once `session_id` is up: at once while awake, else behind the stop under way or the
    // one resume, which an asleep or unknown session starts.
    async fn wake(&self, session_id: SessionId) -> WakeOutcome {
        let woken = {
            let mut sessions = lock(&self.sessions);
            let entry = sessions
                .entry(session_id)
                .or_insert_with(SessionSleep::unknown);
            let (trigger, woken) = oneshot::channel();
            match &mut entry.phase {
                SleepPhase::Awake { idle_since } => {
                    *idle_since = None;
                    return Ok(());
                }
                SleepPhase::Stopping { kept } | SleepPhase::Waking { kept } => kept.push(trigger),
                SleepPhase::Asleep => {
                    entry.phase = SleepPhase::Waking {
                        kept: vec![trigger],
                    };
                    self.begin_resume(session_id, entry);
                }
            }
            woken
        };
        woken
            .await
            .unwrap_or_else(|_| Err(Arc::new(IdleSleepError::WakeAbandoned { session_id })))
    }

    // Wakes a sleeping `session_id` for its timed fire; one awake or waking is left as it is.
    fn wake_on_schedule(&self, session_id: SessionId) {
        let mut sessions = lock(&self.sessions);
        if let Some(entry) = sessions.get_mut(&session_id)
            && matches!(entry.phase, SleepPhase::Asleep)
        {
            entry.phase = SleepPhase::Waking { kept: Vec::new() };
            self.begin_resume(session_id, entry);
        }
    }

    // Starts the one resume of `session_id`, whose entry was just moved to waking.
    fn begin_resume(&self, session_id: SessionId, entry: &mut SessionSleep) {
        if let Some(armed) = entry.armed_wake.take() {
            armed.cancel();
        }
        let idle_sleep = self.shared();
        self.transitions
            .spawn(async move { idle_sleep.resume(session_id).await });
    }

    // Resumes `session_id` through its driver and answers each kept trigger in arrival order: up,
    // the session awake, or the failure, the session left asleep with its next wake armed.
    async fn resume(&self, session_id: SessionId) {
        let outcome = self.wake_process(session_id).await.map_err(Arc::new);
        let kept = {
            let mut sessions = lock(&self.sessions);
            let Some(entry) = sessions.get_mut(&session_id) else {
                return;
            };
            let next = match outcome {
                Ok(()) => SleepPhase::Awake { idle_since: None },
                Err(_) => SleepPhase::Asleep,
            };
            // Only this resume moves its session out of waking.
            let kept = match std::mem::replace(&mut entry.phase, next) {
                SleepPhase::Waking { kept } => kept,
                SleepPhase::Awake { .. } | SleepPhase::Stopping { .. } | SleepPhase::Asleep => {
                    Vec::new()
                }
            };
            if outcome.is_err() {
                self.arm_wake(session_id, entry);
            }
            kept
        };
        if let Err(failure) = &outcome
            && kept.is_empty()
        {
            tracing::warn!(
                session_id = %session_id,
                error = &**failure as &(dyn Error + 'static),
                "a sleeping session's scheduled wake failed; it stays asleep"
            );
        }
        answer_triggers(kept, &outcome);
    }

    // Brings the session's process up through the place a process opens, never straight through
    // its driver, so a conversation is resumed once.
    async fn wake_process(&self, session_id: SessionId) -> Result<(), IdleSleepError> {
        let waker = self
            .process_waker
            .get()
            .and_then(Weak::upgrade)
            .ok_or(IdleSleepError::WakeAbandoned { session_id })?;
        let state = waker
            .wake_process(session_id)
            .await
            .map_err(|cause| IdleSleepError::ProcessNotWoken { session_id, cause })?;
        match state {
            SessionSleepState::Awake => Ok(()),
            SessionSleepState::Asleep => Err(IdleSleepError::NotWoken { session_id }),
        }
    }

    /// The check: every followed session closed or deleted since is forgotten, and each awake one
    /// idle past the limit with nothing holding it is stopped under its lock. A session whose
    /// check fails is written to the log and checked again next time.
    pub(crate) async fn check(&self) {
        let now = Instant::now();
        let followed: Vec<SessionId> = lock(&self.sessions).keys().copied().collect();
        for session_id in followed {
            if let Err(error) = self.check_session(session_id, now).await {
                tracing::warn!(
                    session_id = %session_id,
                    error = &error as &(dyn Error + 'static),
                    "the idle sleep could not check a session; its next check tries again"
                );
            }
        }
    }

    async fn check_session(
        &self,
        session_id: SessionId,
        now: Instant,
    ) -> Result<(), IdleSleepError> {
        match read_session_state_through::<IdleSleepError>(&self.deps.pool, session_id).await? {
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

    // Stops `session_id`'s process under its transition lock once every hold, read again there,
    // still finds none; a trigger that came while it stopped wakes it after the exit.
    async fn stop_session(&self, session_id: SessionId) {
        let held = self.deps.transition_lock.acquire(session_id).await;
        if !self.begin_stopping(session_id) {
            return;
        }
        let stopped = self.stop_unless_held(session_id).await;
        let (still_awake, is_wake_due) = {
            let mut sessions = lock(&self.sessions);
            let Some(entry) = sessions.get_mut(&session_id) else {
                return;
            };
            let next = match &stopped {
                Ok(StopOutcome::Asleep) => SleepPhase::Asleep,
                Ok(StopOutcome::Held) => SleepPhase::Awake { idle_since: None },
                // Tried again once the session is idle for the limit once more.
                Ok(StopOutcome::NeverSleeps) | Err(_) => SleepPhase::Awake {
                    idle_since: Some(Instant::now()),
                },
            };
            // Only this stop moves its session out of stopping.
            let kept = match std::mem::replace(&mut entry.phase, next) {
                SleepPhase::Stopping { kept } => kept,
                SleepPhase::Awake { .. } | SleepPhase::Asleep | SleepPhase::Waking { .. } => {
                    Vec::new()
                }
            };
            match (&stopped, kept.is_empty() && entry.registered_holds == 0) {
                (Ok(StopOutcome::Asleep), true) => {
                    self.arm_wake(session_id, entry);
                    (Vec::new(), false)
                }
                (Ok(StopOutcome::Asleep), false) => {
                    entry.phase = SleepPhase::Waking { kept };
                    (Vec::new(), true)
                }
                (Ok(StopOutcome::Held | StopOutcome::NeverSleeps) | Err(_), _) => (kept, false),
            }
        };
        if let Err(error) = &stopped {
            tracing::warn!(
                session_id = %session_id,
                error = error as &(dyn Error + 'static),
                "an idle session's stop failed; it stays awake"
            );
        }
        // Each trigger kept while the stop decided against it finds its session up.
        answer_triggers(still_awake, &Ok(()));
        // The resume takes no transition lock, so it is let go first.
        drop(held);
        if is_wake_due {
            self.resume(session_id).await;
        }
    }

    // Moves `session_id` to stopping while it is still awake, unheld and idle past the limit.
    fn begin_stopping(&self, session_id: SessionId) -> bool {
        let mut sessions = lock(&self.sessions);
        let Some(entry) = sessions.get_mut(&session_id) else {
            return false;
        };
        let is_due = entry.registered_holds == 0
            && matches!(
                entry.phase,
                SleepPhase::Awake { idle_since: Some(since) }
                    if Instant::now().duration_since(since) >= IDLE_LIMIT
            );
        if is_due {
            entry.phase = SleepPhase::Stopping { kept: Vec::new() };
        }
        is_due
    }

    // Reads every hold again and, with none and no trigger come since, stops the process.
    async fn stop_unless_held(&self, session_id: SessionId) -> Result<StopOutcome, IdleSleepError> {
        let driver = self.session_driver(session_id).await?;
        let holds = self.read_holds(driver.as_ref(), session_id).await?;
        // Stored before the stop, so the daemon's next start finds what wakes the session; a
        // session whose fires were not stored stays awake, so the next check stores them again.
        let are_schedules_stored = self.keep_schedules(session_id, &holds.schedules).await;
        if !are_schedules_stored || holds.is_held || self.is_triggered_while_stopping(session_id) {
            return Ok(StopOutcome::Held);
        }
        Ok(match driver.sleep_session(session_id).await? {
            SessionSleepState::Asleep => StopOutcome::Asleep,
            SessionSleepState::Awake => StopOutcome::NeverSleeps,
        })
    }

    fn is_awake_and_unheld(&self, session_id: SessionId) -> bool {
        lock(&self.sessions).get(&session_id).is_some_and(|entry| {
            entry.registered_holds == 0 && matches!(entry.phase, SleepPhase::Awake { .. })
        })
    }

    fn is_triggered_while_stopping(&self, session_id: SessionId) -> bool {
        lock(&self.sessions).get(&session_id).is_some_and(|entry| {
            entry.registered_holds > 0
                || matches!(&entry.phase, SleepPhase::Stopping { kept } if !kept.is_empty())
        })
    }

    async fn read_holds(
        &self,
        driver: &dyn ProviderDriver,
        session_id: SessionId,
    ) -> Result<SessionHolds, IdleSleepError> {
        let sources = HoldSources {
            pool: &self.deps.pool,
            running_commands: &self.deps.running_commands,
            driver,
        };
        read_session_holds(&sources, session_id, Timestamp::now(), &TimeZone::system()).await
    }

    // Keeps `schedules` as `session_id`'s timed fires, which its armed wake follows, and stores
    // them when they differ from those stored; answers whether they are stored. A failed store is
    // logged once and tried again at the next check.
    async fn keep_schedules(&self, session_id: SessionId, schedules: &[KeptSchedule]) -> bool {
        {
            let mut sessions = lock(&self.sessions);
            let Some(entry) = sessions.get_mut(&session_id) else {
                return true;
            };
            if entry.are_schedules_stored && entry.kept_schedules == schedules {
                return true;
            }
            entry.kept_schedules = schedules.to_vec();
        }
        let stored = self
            .deps
            .writer
            .write(replace_schedules_statements(session_id, schedules))
            .await;
        let mut sessions = lock(&self.sessions);
        let Some(entry) = sessions.get_mut(&session_id) else {
            return stored.is_ok();
        };
        match stored {
            // A newer read kept other fires while this one was written; the next check stores them.
            Ok(_) => {
                entry.are_schedules_stored = entry.kept_schedules == schedules;
                entry.is_store_failure_logged = false;
                true
            }
            Err(error) => {
                entry.are_schedules_stored = false;
                if !entry.is_store_failure_logged {
                    entry.is_store_failure_logged = true;
                    tracing::warn!(
                        session_id = %session_id,
                        error = &error as &(dyn Error + 'static),
                        "a session's timed fires were not stored; it stays awake and each check \
                         tries again"
                    );
                }
                false
            }
        }
    }

    // Stops following a closed or deleted session: its scheduled wake and stored schedules go. A
    // stop or resume under way finishes first; the next check forgets it then.
    async fn forget(&self, session_id: SessionId) -> Result<(), IdleSleepError> {
        {
            let mut sessions = lock(&self.sessions);
            let is_settled = sessions.get(&session_id).is_some_and(|entry| {
                matches!(entry.phase, SleepPhase::Awake { .. } | SleepPhase::Asleep)
            });
            if !is_settled {
                return Ok(());
            }
            if let Some(armed) = sessions
                .remove(&session_id)
                .and_then(|entry| entry.armed_wake)
            {
                armed.cancel();
            }
        }
        self.deps
            .writer
            .write(vec![delete_schedules_statement(session_id)])
            .await?;
        Ok(())
    }

    // Arms the wake of sleeping `session_id` for its next timed fire, in place of any armed one. A
    // wake the scheduler refuses is written to the log; the session then wakes for a message only.
    fn arm_wake(&self, session_id: SessionId, entry: &mut SessionSleep) {
        if let Some(armed) = entry.armed_wake.take() {
            armed.cancel();
        }
        let Some(wake_at) =
            next_wake_at(&entry.kept_schedules, Timestamp::now(), &TimeZone::system())
        else {
            return;
        };
        let waking = self.this.clone();
        let scheduled = self.deps.scheduler.schedule_at(
            SCHEDULED_WAKE_JOB,
            JobCondition::Always,
            SystemTime::from(wake_at),
            move |_| {
                if let Some(idle_sleep) = waking.upgrade() {
                    idle_sleep.wake_on_schedule(session_id);
                }
                async { Ok(()) }.boxed()
            },
        );
        match scheduled {
            Ok(armed) => entry.armed_wake = Some(armed),
            Err(error) => tracing::warn!(
                session_id = %session_id,
                error = &error as &(dyn Error + 'static),
                "a sleeping session's scheduled wake could not be armed"
            ),
        }
    }

    async fn session_driver(
        &self,
        session_id: SessionId,
    ) -> Result<Arc<dyn ProviderDriver>, IdleSleepError> {
        let (_, _, driver) = read_session_driver::<IdleSleepError>(
            &self.deps.pool,
            &self.deps.providers,
            self.deps.read_damaged_from_sequence.as_ref(),
            session_id,
        )
        .await?;
        Ok(driver)
    }

    /// Where `session_id`'s next scheduled wake is armed for, so a test reads what a sleep armed.
    #[cfg(test)]
    pub(crate) fn armed_wake_at(&self, session_id: SessionId) -> Option<Timestamp> {
        lock(&self.sessions).get(&session_id).and_then(|entry| {
            entry.armed_wake.as_ref()?;
            next_wake_at(&entry.kept_schedules, Timestamp::now(), &TimeZone::system())
        })
    }

    /// Waits for every stop and resume under way, so a test reads where they left each session.
    #[cfg(test)]
    pub(crate) async fn settle_transitions(&self) {
        self.transitions.close();
        self.transitions.wait().await;
        self.transitions.reopen();
    }

    /// Fires `session_id`'s scheduled wake as the scheduler does when its instant comes.
    #[cfg(test)]
    pub(crate) fn fire_scheduled_wake(&self, session_id: SessionId) {
        self.wake_on_schedule(session_id);
    }
}

impl SessionProcessFollower for SessionIdleSleep {
    fn follow_awake(&self, session_id: SessionId) {
        let mut sessions = lock(&self.sessions);
        let entry = sessions
            .entry(session_id)
            .or_insert_with(SessionSleep::unknown);
        // A stop or resume under way settles the session itself.
        if matches!(entry.phase, SleepPhase::Asleep) {
            if let Some(armed) = entry.armed_wake.take() {
                armed.cancel();
            }
            entry.phase = SleepPhase::Awake { idle_since: None };
        }
    }

    fn forget_closed(&self, session_id: SessionId) {
        let idle_sleep = self.shared();
        self.transitions.spawn(async move {
            if let Err(error) = idle_sleep.forget(session_id).await {
                tracing::warn!(
                    session_id = %session_id,
                    error = &error as &(dyn Error + 'static),
                    "a closed session's timed fires were not removed; the next check tries again"
                );
            }
        });
    }
}

impl SessionWaker for SessionIdleSleep {
    fn wake_for_message(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async move {
            self.wake(session_id)
                .await
                .map_err(|failure| Box::new(failure) as Box<dyn Error + Send + Sync>)
        }
        .boxed()
    }
}

// Answers each kept trigger with `outcome`, in arrival order.
fn answer_triggers(kept: Vec<oneshot::Sender<WakeOutcome>>, outcome: &WakeOutcome) {
    for trigger in kept {
        // A trigger whose caller stopped waiting no longer listens.
        trigger.send(outcome.clone()).unwrap_or_default();
    }
}
