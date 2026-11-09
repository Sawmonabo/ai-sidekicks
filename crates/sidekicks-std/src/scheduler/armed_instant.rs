//! One job held armed on the wall clock's timer for the next instant its owner names: armed again
//! in place whenever the instant moves, and, when the system refuses the timer, a read of what is
//! next fails or the job itself fails, tried again a minute later on the monotonic clock and again
//! each minute while it keeps failing.
//!
//! The job and its retry are timers that only hand the owner's work to a task of the scheduler's,
//! which its stop waits for, so a fire that waits on the database holds no other timer. That task
//! runs the owner's fires and rearms one at a time in order; while one runs, at most one fire
//! waits, the latest instant, and one rearm.

use std::error::Error;
use std::sync::{Arc, Mutex, Weak};
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

    /// The work run once the wall clock reaches `instant`, which covers every earlier instant, since
    /// a fire waiting behind a running one gives way to a later one; a failure is retried a minute
    /// later through [`InstantJob::rearm`].
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
    // The owner's fires and rearms waiting for, or running on, the task that runs them.
    owner_work: Mutex<OwnerWork>,
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

// The work the owner's task has still to run.
#[derive(Default)]
struct OwnerWork {
    // Set while the task runs, so new work waits for it rather than starting a second.
    // Cleared when a piece of work panics, so the next hand-over starts a new task and runs
    // what waits.
    is_running: bool,
    // The latest instant whose fire waits.
    waiting_fire: Option<SystemTime>,
    is_rearm_waiting: bool,
}

// One piece of the owner's work.
#[derive(Clone, Copy)]
enum OwnerWorkItem {
    Fire(SystemTime),
    Rearm,
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
            owner_work: Mutex::default(),
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
            if let Some(owner) = firing.upgrade() {
                owner.armed_instant().disarm(arm);
                hand_over(&owner, OwnerWorkItem::Fire(instant));
            }
            async { Ok(()) }.boxed()
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
            if let Some(owner) = retrying.upgrade() {
                hand_over(&owner, OwnerWorkItem::Rearm);
            }
            async { Ok(()) }.boxed()
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

// Hands `item` to `owner`'s task, starting it when none runs, and returns at once.
fn hand_over<Owner: InstantJob>(owner: &Arc<Owner>, item: OwnerWorkItem) {
    let mut work = lock(&owner.armed_instant().owner_work);
    match item {
        OwnerWorkItem::Fire(instant) => {
            work.waiting_fire = Some(
                work.waiting_fire
                    .map_or(instant, |waiting| waiting.max(instant)),
            );
        }
        OwnerWorkItem::Rearm => work.is_rearm_waiting = true,
    }
    if work.is_running {
        return;
    }
    work.is_running = true;
    owner
        .armed_instant()
        .scheduler
        .spawn_owner_task(run_owner_work(Arc::downgrade(owner)));
}

// Runs the owner's waiting work one piece at a time, a waiting fire before a waiting rearm, until
// none waits or the owner is gone.
async fn run_owner_work<Owner: InstantJob>(working: Weak<Owner>) {
    while let Some(owner) = working.upgrade() {
        let item = {
            let mut work = lock(&owner.armed_instant().owner_work);
            if let Some(instant) = work.waiting_fire.take() {
                OwnerWorkItem::Fire(instant)
            } else if std::mem::take(&mut work.is_rearm_waiting) {
                OwnerWorkItem::Rearm
            } else {
                work.is_running = false;
                return;
            }
        };
        let _running = ClearRunningOnPanic(owner.armed_instant());
        match item {
            OwnerWorkItem::Fire(instant) => {
                if let Err(error) = Arc::clone(&owner).fire(instant).await {
                    retry_failed_job(&owner, &*error);
                }
            }
            OwnerWorkItem::Rearm => Arc::clone(&owner).rearm().await,
        }
    }
}

// Clears the running mark when the piece of work it is held across panics, which ends the task.
struct ClearRunningOnPanic<'armed>(&'armed ArmedInstant);

impl Drop for ClearRunningOnPanic<'_> {
    fn drop(&mut self) {
        // Only on a panic: after a normal end the task itself clears the mark under the lock, and a
        // new task may already hold it.
        if std::thread::panicking() {
            lock(&self.0.owner_work).is_running = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::error::Error;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, SystemTime};

    use futures::FutureExt as _;
    use futures::future::BoxFuture;
    use sidekicks_platforms::WallClock as _;
    use tokio::sync::{mpsc, oneshot, watch};
    use tokio::time::Instant;

    use super::{ArmedInstant, InstantJob};
    use crate::mutex_lock::lock;
    use crate::scheduler::test_wall_clock::TestWallClock;
    use crate::scheduler::{JobCondition, Scheduler, SchedulerStopError};

    const RUN_BOUND: Duration = Duration::from_secs(5);

    // An owner whose fire tells its start and then waits for the test's release.
    struct HeldFireOwner {
        armed: ArmedInstant,
        started: Mutex<Option<oneshot::Sender<()>>>,
        release: Mutex<Option<oneshot::Receiver<()>>>,
    }

    impl InstantJob for HeldFireOwner {
        fn armed_instant(&self) -> &ArmedInstant {
            &self.armed
        }

        fn fire(
            self: Arc<Self>,
            _instant: SystemTime,
        ) -> BoxFuture<'static, Result<(), Box<dyn Error + Send + Sync>>> {
            let started = lock(&self.started).take();
            let release = lock(&self.release).take();
            async move {
                if let Some(started) = started {
                    started.send(()).expect("the test waits for the fire");
                }
                if let Some(release) = release {
                    release.await.expect("the test releases the fire");
                }
                Ok(())
            }
            .boxed()
        }

        fn rearm(self: Arc<Self>) -> BoxFuture<'static, ()> {
            async {}.boxed()
        }
    }

    // An owner whose first fire panics after telling its instant, and whose later fires only tell
    // theirs.
    struct PanickingFireOwner {
        armed: ArmedInstant,
        has_fired: AtomicBool,
        fired: mpsc::UnboundedSender<SystemTime>,
    }

    impl InstantJob for PanickingFireOwner {
        fn armed_instant(&self) -> &ArmedInstant {
            &self.armed
        }

        fn fire(
            self: Arc<Self>,
            instant: SystemTime,
        ) -> BoxFuture<'static, Result<(), Box<dyn Error + Send + Sync>>> {
            let is_first = !self.has_fired.swap(true, Ordering::AcqRel);
            let fired = self.fired.clone();
            async move {
                fired.send(instant).expect("the test reads each fire");
                assert!(!is_first, "the test's first fire panics");
                Ok(())
            }
            .boxed()
        }

        fn rearm(self: Arc<Self>) -> BoxFuture<'static, ()> {
            async {}.boxed()
        }
    }

    // A fire that waits, as one waiting on the database's writer, holds no timer: a timer due one
    // second later runs at its own deadline while the fire still waits. Killed by the fire awaited
    // on the scheduler's task, which holds the timer until the release.
    #[tokio::test(start_paused = true)]
    async fn a_waiting_fire_holds_no_timer() {
        let wall_clock = Arc::new(TestWallClock::default());
        let scheduler = Arc::new(Scheduler::start(
            wall_clock.clone(),
            None,
            watch::channel(0).1,
        ));
        let (started, fire_started) = oneshot::channel();
        let (release, released) = oneshot::channel();
        let owner = Arc::new(HeldFireOwner {
            armed: ArmedInstant::new(Arc::clone(&scheduler), "held test fire", "test retry"),
            started: Mutex::new(Some(started)),
            release: Mutex::new(Some(released)),
        });
        let instant = wall_clock.now() + Duration::from_hours(1);
        ArmedInstant::arm(&owner, Some(instant));
        wall_clock.set_now(instant);
        tokio::time::timeout(RUN_BOUND, fire_started)
            .await
            .expect("the fire starts")
            .expect("the fire reports its start");

        let deadline = Instant::now() + Duration::from_secs(1);
        let (ran, timer_ran) = oneshot::channel();
        let mut ran = Some(ran);
        let _timer = scheduler
            .schedule(
                "test timer",
                JobCondition::Always,
                Duration::from_secs(1),
                move |_| {
                    if let Some(ran) = ran.take() {
                        ran.send(()).expect("the test waits for the timer");
                    }
                    async { Ok(()) }.boxed()
                },
            )
            .expect("the timer is scheduled");
        tokio::time::timeout(RUN_BOUND, timer_ran)
            .await
            .expect("the timer runs while the fire waits")
            .expect("the timer reports its run");
        assert_eq!(Instant::now() - deadline, Duration::ZERO);

        release.send(()).expect("the fire waits for its release");
        scheduler
            .stop(Instant::now() + RUN_BOUND)
            .await
            .expect("the task ends");
    }

    // The scheduler's stop waits for a fire still running, since the fire may still call into what
    // the program stops after the scheduler, and ends once the fire does. Killed by the stop
    // waiting for the scheduler's task alone, which returns while the fire still runs.
    #[tokio::test(start_paused = true)]
    async fn the_stop_waits_for_a_running_fire() {
        let wall_clock = Arc::new(TestWallClock::default());
        let scheduler = Arc::new(Scheduler::start(
            wall_clock.clone(),
            None,
            watch::channel(0).1,
        ));
        let (started, fire_started) = oneshot::channel();
        let (release, released) = oneshot::channel();
        let owner = Arc::new(HeldFireOwner {
            armed: ArmedInstant::new(Arc::clone(&scheduler), "held test fire", "test retry"),
            started: Mutex::new(Some(started)),
            release: Mutex::new(Some(released)),
        });
        let instant = wall_clock.now() + Duration::from_hours(1);
        ArmedInstant::arm(&owner, Some(instant));
        wall_clock.set_now(instant);
        tokio::time::timeout(RUN_BOUND, fire_started)
            .await
            .expect("the fire starts")
            .expect("the fire reports its start");

        let stopping = tokio::spawn({
            let scheduler = Arc::clone(&scheduler);
            async move { scheduler.stop(Instant::now() + RUN_BOUND).await }
        });
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(!stopping.is_finished(), "the stop waits for the fire");
        release.send(()).expect("the fire waits for its release");
        tokio::time::timeout(RUN_BOUND, stopping)
            .await
            .expect("the stop ends once the fire does")
            .expect("the stop's task ends")
            .expect("the fire ends cleanly");
    }

    // A fire that panics leaves its owner firing: the next instant still fires, and the stop
    // answers the panic. Killed by the running mark left set on the panic, which keeps every
    // later fire waiting for a task that ended.
    #[tokio::test(start_paused = true)]
    async fn a_panicking_fire_leaves_the_owner_firing() {
        let wall_clock = Arc::new(TestWallClock::default());
        let scheduler = Arc::new(Scheduler::start(
            wall_clock.clone(),
            None,
            watch::channel(0).1,
        ));
        let (fired, mut fires) = mpsc::unbounded_channel();
        let owner = Arc::new(PanickingFireOwner {
            armed: ArmedInstant::new(Arc::clone(&scheduler), "panicking test fire", "test retry"),
            has_fired: AtomicBool::new(false),
            fired,
        });
        for hours in [1, 2] {
            let instant = wall_clock.now() + Duration::from_hours(hours);
            ArmedInstant::arm(&owner, Some(instant));
            wall_clock.set_now(instant);
            let fired = tokio::time::timeout(RUN_BOUND, fires.recv())
                .await
                .expect("the instant fires")
                .expect("the owner tells its fire");
            assert_eq!(fired, instant);
        }
        let stopped = scheduler.stop(Instant::now() + RUN_BOUND).await;
        assert!(
            matches!(stopped, Err(SchedulerStopError::Panicked(_))),
            "{stopped:?}"
        );
    }
}
