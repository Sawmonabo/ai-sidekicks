//! The scheduler's order, clocks and conditions.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime};

use futures::future::BoxFuture;
use sidekicks_contracts::run::state::RunState;
use sidekicks_platforms::{WallClock, WallClockWait};
use tokio::sync::{Notify, oneshot};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::{JobCondition, ScheduleError, ScheduledJobOutcome, Scheduler};
use crate::session::run::live_count::LiveRunCount;

// Far longer than any periodic look would wait between two looks.
const IDLE_SPAN: Duration = Duration::from_secs(600);

// When the test's wall clock starts, how far ahead a job's instant is, and where the clock
// jumps to, as a sleep the tokio clock does not see would move it.
const CLOCK_START: Duration = Duration::from_hours(500_000);
const INSTANT_AHEAD: Duration = Duration::from_secs(3_600);
const JUMP_AHEAD: Duration = Duration::from_secs(7_200);

// How long the test waits for a run that must come.
const RUN_BOUND: Duration = Duration::from_secs(5);

// A wall clock the test sets, whose timer fires once the clock reaches the armed instant,
// which refuses to arm while told to, and which counts the scheduler's waits on it, one per
// turn of its task.
struct TestWallClock {
    now: Mutex<SystemTime>,
    armed_instant: Mutex<Option<SystemTime>>,
    is_arm_refused: AtomicBool,
    fired: Notify,
    wait_count: AtomicUsize,
}

impl TestWallClock {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            now: Mutex::new(SystemTime::UNIX_EPOCH + CLOCK_START),
            armed_instant: Mutex::new(None),
            is_arm_refused: AtomicBool::new(false),
            fired: Notify::new(),
            wait_count: AtomicUsize::new(0),
        })
    }

    fn set_now(&self, now: SystemTime) {
        *lock(&self.now) = now;
        self.fire_if_reached();
    }

    fn fire_if_reached(&self) {
        let now = self.now();
        let mut armed_instant = lock(&self.armed_instant);
        if armed_instant.is_some_and(|instant| instant <= now) {
            *armed_instant = None;
            self.fired.notify_one();
        }
    }
}

impl WallClock for TestWallClock {
    fn now(&self) -> SystemTime {
        *lock(&self.now)
    }

    fn arm(&self, instant: SystemTime) -> std::io::Result<()> {
        if self.is_arm_refused.load(Ordering::Relaxed) {
            return Err(std::io::Error::other("the test refuses the arm"));
        }
        *lock(&self.armed_instant) = Some(instant);
        self.fire_if_reached();
        Ok(())
    }

    fn disarm(&self) -> std::io::Result<()> {
        *lock(&self.armed_instant) = None;
        Ok(())
    }

    fn wait(&self) -> WallClockWait<'_> {
        self.wait_count.fetch_add(1, Ordering::Relaxed);
        Box::pin(async move {
            self.fired.notified().await;
            Ok(())
        })
    }
}

// A job that reports its first run on `ran` and counts every run in `run_count`.
fn reporting_job(
    ran: oneshot::Sender<()>,
    run_count: &Arc<AtomicUsize>,
) -> impl FnMut(CancellationToken) -> BoxFuture<'static, ScheduledJobOutcome> + Send + 'static {
    let run_count = Arc::clone(run_count);
    let mut ran = Some(ran);
    move |_| {
        run_count.fetch_add(1, Ordering::Relaxed);
        let ran = ran.take();
        Box::pin(async move {
            if let Some(ran) = ran {
                ran.send(()).expect("the test waits for the run");
            }
            Ok(())
        })
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[tokio::test(start_paused = true)]
async fn an_idle_scheduler_arms_nothing_and_turns_no_more() {
    let wall_clock = TestWallClock::new();
    let scheduler = Scheduler::start(wall_clock.clone(), None, LiveRunCount::default().follow());
    // A receiver waits for wakes, which must not turn the task.
    let _wakes = scheduler.on_wake();

    // tokio's paused clock jumps to every timer the task arms, so a periodic look would turn
    // the task again.
    tokio::time::sleep(IDLE_SPAN).await;

    assert_eq!(wall_clock.wait_count.load(Ordering::Relaxed), 1);
    scheduler.stop().await.expect("the task ends");
}

#[tokio::test(start_paused = true)]
async fn a_wall_clock_job_runs_once_when_the_clock_jumps_past_its_instant() {
    let wall_clock = TestWallClock::new();
    let scheduler = Scheduler::start(wall_clock.clone(), None, LiveRunCount::default().follow());
    let run_count = Arc::new(AtomicUsize::new(0));
    let (ran, wall_clock_job_ran) = oneshot::channel();
    scheduler
        .schedule_at(
            "wall-clock test job",
            JobCondition::Always,
            wall_clock.now() + INSTANT_AHEAD,
            reporting_job(ran, &run_count),
        )
        .expect("the job is scheduled");
    // A job due now makes the task look at what is due while the instant is still ahead.
    let (looked, looked_at_due_runs) = oneshot::channel();
    scheduler
        .schedule(
            "due-now test job",
            JobCondition::Always,
            Duration::ZERO,
            reporting_job(looked, &Arc::new(AtomicUsize::new(0))),
        )
        .expect("the job is scheduled");
    looked_at_due_runs.await.expect("the job due now runs");
    assert_eq!(run_count.load(Ordering::Relaxed), 0);

    let jumped_at = Instant::now();
    wall_clock.set_now(wall_clock.now() + JUMP_AHEAD);
    tokio::time::timeout(RUN_BOUND, wall_clock_job_ran)
        .await
        .expect("the job runs once the clock is past its instant")
        .expect("the job reports its run");
    assert_eq!(
        Instant::now(),
        jumped_at,
        "the run waited on no tokio timer"
    );

    tokio::time::sleep(IDLE_SPAN).await;
    assert_eq!(run_count.load(Ordering::Relaxed), 1);
    scheduler.stop().await.expect("the task ends");
}

#[tokio::test(start_paused = true)]
async fn a_refused_rearm_is_told_to_its_job_and_later_jobs_still_run() {
    let wall_clock = TestWallClock::new();
    let scheduler = Scheduler::start(wall_clock.clone(), None, LiveRunCount::default().follow());
    let started_at = wall_clock.now();
    let run_count = Arc::new(AtomicUsize::new(0));
    let (first_ran, first_job_ran) = oneshot::channel();
    let _first = scheduler
        .schedule_at(
            "first test job",
            JobCondition::Always,
            started_at + INSTANT_AHEAD,
            reporting_job(first_ran, &run_count),
        )
        .expect("the first job is scheduled");
    let (second_ran, _second_job_ran) = oneshot::channel();
    let mut second = scheduler
        .schedule_at(
            "second test job",
            JobCondition::Always,
            started_at + JUMP_AHEAD,
            reporting_job(second_ran, &run_count),
        )
        .expect("the second job is scheduled");

    // The first job runs, and the arm for the second is refused.
    wall_clock.is_arm_refused.store(true, Ordering::Relaxed);
    wall_clock.set_now(started_at + INSTANT_AHEAD);
    tokio::time::timeout(RUN_BOUND, first_job_ran)
        .await
        .expect("the first job runs once the clock reaches its instant")
        .expect("the first job reports its run");
    let refusal = tokio::time::timeout(RUN_BOUND, second.refusal())
        .await
        .expect("the second job's instant is settled");
    assert!(
        matches!(
            refusal,
            Some(ScheduleError::TimerNotArmed {
                job: "second test job",
                ..
            })
        ),
        "the second job's handle is told the timer was not armed, not {refusal:?}"
    );

    // The task still turns: a job scheduled once arming works again runs at its instant.
    wall_clock.is_arm_refused.store(false, Ordering::Relaxed);
    let (third_ran, third_job_ran) = oneshot::channel();
    let _third = scheduler
        .schedule_at(
            "third test job",
            JobCondition::Always,
            started_at + JUMP_AHEAD,
            reporting_job(third_ran, &run_count),
        )
        .expect("the third job is scheduled");
    wall_clock.set_now(started_at + JUMP_AHEAD);
    tokio::time::timeout(RUN_BOUND, third_job_ran)
        .await
        .expect("the third job runs once the clock reaches its instant")
        .expect("the third job reports its run");
    assert_eq!(run_count.load(Ordering::Relaxed), 2);
    scheduler.stop().await.expect("the task ends");
}

// A job that may run only while no run is live is parked while one is, and the task goes on
// running other jobs; it runs once the last live run ends. Killed by the condition ignored, by a
// parked job holding the task, and by a count change that does not wake the task.
#[tokio::test(start_paused = true)]
async fn a_job_waiting_for_no_live_run_holds_no_other_job_and_runs_when_runs_end() {
    let wall_clock = TestWallClock::new();
    let live_runs = LiveRunCount::default();
    live_runs.record(RunState::Queued, RunState::Running);
    let scheduler = Scheduler::start(wall_clock, None, live_runs.follow());
    let quiet_count = Arc::new(AtomicUsize::new(0));
    let (quiet_ran, quiet_job_ran) = oneshot::channel();
    let _quiet = scheduler
        .schedule(
            "quiet test job",
            JobCondition::NoTurnRunning,
            Duration::ZERO,
            reporting_job(quiet_ran, &quiet_count),
        )
        .expect("the job is scheduled");
    let (other_ran, other_job_ran) = oneshot::channel();
    let _other = scheduler
        .schedule(
            "other test job",
            JobCondition::Always,
            Duration::from_secs(1),
            reporting_job(other_ran, &Arc::new(AtomicUsize::new(0))),
        )
        .expect("the job is scheduled");

    tokio::time::timeout(RUN_BOUND, other_job_ran)
        .await
        .expect("a job due after the parked one still runs")
        .expect("the job reports its run");
    tokio::time::sleep(IDLE_SPAN).await;
    assert_eq!(quiet_count.load(Ordering::Relaxed), 0);

    live_runs.record(RunState::Running, RunState::Completed);
    tokio::time::timeout(RUN_BOUND, quiet_job_ran)
        .await
        .expect("the parked job runs once no run is live")
        .expect("the job reports its run");
    assert_eq!(quiet_count.load(Ordering::Relaxed), 1);
    scheduler.stop().await.expect("the task ends");
}

// A run that goes live while an earlier job of the same drain runs parks the job after it, which
// runs once the run ends. Killed by the count read once per drain, which runs it beside the turn.
#[tokio::test(start_paused = true)]
async fn a_run_going_live_mid_drain_parks_the_jobs_after_it() {
    let live_runs = Arc::new(LiveRunCount::default());
    let scheduler = Scheduler::start(TestWallClock::new(), None, live_runs.follow());
    let (turn_started, turn_job_ran) = oneshot::channel();
    let starting = Arc::clone(&live_runs);
    let mut turn_started = Some(turn_started);
    let _turn = scheduler
        .schedule(
            "turn test job",
            JobCondition::Always,
            Duration::ZERO,
            move |_| {
                starting.record(RunState::Queued, RunState::Running);
                let turn_started = turn_started.take();
                Box::pin(async move {
                    if let Some(turn_started) = turn_started {
                        turn_started.send(()).expect("the test waits for the turn");
                    }
                    Ok(())
                })
            },
        )
        .expect("the job is scheduled");
    let quiet_count = Arc::new(AtomicUsize::new(0));
    let (quiet_ran, quiet_job_ran) = oneshot::channel();
    let _quiet = scheduler
        .schedule(
            "repack test job",
            JobCondition::NoTurnRunning,
            Duration::ZERO,
            reporting_job(quiet_ran, &quiet_count),
        )
        .expect("the job is scheduled");

    tokio::time::timeout(RUN_BOUND, turn_job_ran)
        .await
        .expect("the turn's job runs")
        .expect("the job reports its run");
    tokio::time::sleep(IDLE_SPAN).await;
    assert_eq!(quiet_count.load(Ordering::Relaxed), 0);

    live_runs.record(RunState::Running, RunState::Completed);
    tokio::time::timeout(RUN_BOUND, quiet_job_ran)
        .await
        .expect("the parked job runs once the turn ends")
        .expect("the job reports its run");
    scheduler.stop().await.expect("the task ends");
}

// A job bounded 25 hours ahead on the wall clock runs once that clock reaches the bound though a
// run is still live, and not before, however long tokio's clock, which stops in sleep, runs on.
// Killed by the bound missing, so the job waits forever, by a bound read as no wait at all, and
// by a bound kept on tokio's clock.
#[tokio::test(start_paused = true)]
async fn a_bounded_job_runs_at_its_wall_clock_bound_with_a_run_still_live() {
    const BOUND: Duration = Duration::from_hours(25);
    let wall_clock = TestWallClock::new();
    let live_runs = LiveRunCount::default();
    live_runs.record(RunState::Queued, RunState::Starting);
    let scheduler = Scheduler::start(wall_clock.clone(), None, live_runs.follow());
    let started_at = wall_clock.now();
    let run_count = Arc::new(AtomicUsize::new(0));
    let (ran, job_ran) = oneshot::channel();
    let _bounded = scheduler
        .schedule(
            "bounded test job",
            JobCondition::NoTurnRunningUntil(started_at + BOUND),
            Duration::ZERO,
            reporting_job(ran, &run_count),
        )
        .expect("the job is scheduled");

    wall_clock.set_now(started_at + Duration::from_hours(24));
    tokio::time::sleep(Duration::from_hours(26)).await;
    assert_eq!(run_count.load(Ordering::Relaxed), 0);
    wall_clock.set_now(started_at + BOUND);
    tokio::time::timeout(RUN_BOUND, job_ran)
        .await
        .expect("the job runs at its bound")
        .expect("the job reports its run");
    assert_eq!(*live_runs.follow().borrow(), 1);
    scheduler.stop().await.expect("the task ends");
}
