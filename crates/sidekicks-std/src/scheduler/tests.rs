//! The scheduler's order, clocks and conditions.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures::future::BoxFuture;
use sidekicks_platforms::WallClock;
use tokio::sync::{oneshot, watch};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::test_wall_clock::TestWallClock;
use super::{JobCondition, ScheduleError, ScheduledJobOutcome, Scheduler};

// Far longer than any periodic look would wait between two looks.
const IDLE_SPAN: Duration = Duration::from_secs(600);

// How far ahead a job's instant is, and where the clock jumps to, as a sleep the tokio clock does
// not see would move it.
const INSTANT_AHEAD: Duration = Duration::from_secs(3_600);
const JUMP_AHEAD: Duration = Duration::from_secs(7_200);

// How long the test waits for a run that must come.
const RUN_BOUND: Duration = Duration::from_secs(5);

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

#[tokio::test(start_paused = true)]
async fn an_idle_scheduler_arms_nothing_and_turns_no_more() {
    let wall_clock = Arc::new(TestWallClock::default());
    let scheduler = Scheduler::start(wall_clock.clone(), None, watch::channel(0).1);
    // A receiver waits for wakes, which must not turn the task.
    let _wakes = scheduler.on_wake();

    // tokio's paused clock jumps to every timer the task arms, so a periodic look would turn
    // the task again.
    tokio::time::sleep(IDLE_SPAN).await;

    assert_eq!(wall_clock.wait_count(), 1);
    scheduler.stop().await.expect("the task ends");
}

#[tokio::test(start_paused = true)]
async fn a_wall_clock_job_runs_once_when_the_clock_jumps_past_its_instant() {
    let wall_clock = Arc::new(TestWallClock::default());
    let scheduler = Scheduler::start(wall_clock.clone(), None, watch::channel(0).1);
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
    let wall_clock = Arc::new(TestWallClock::default());
    let scheduler = Scheduler::start(wall_clock.clone(), None, watch::channel(0).1);
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
    wall_clock.refuse_arms(true);
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
    wall_clock.refuse_arms(false);
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

// A job that may run only while the busy count is zero is parked while it is above zero, and the
// task goes on running other jobs; it runs once the count falls to zero. Killed by the condition
// ignored, by a parked job holding the task, and by a count change that does not wake the task.
#[tokio::test(start_paused = true)]
async fn a_job_waiting_for_idle_holds_no_other_job_and_runs_when_the_count_falls_to_zero() {
    let (busy, busy_count) = watch::channel(1);
    let scheduler = Scheduler::start(Arc::new(TestWallClock::default()), None, busy_count);
    let quiet_count = Arc::new(AtomicUsize::new(0));
    let (quiet_ran, quiet_job_ran) = oneshot::channel();
    let _quiet = scheduler
        .schedule(
            "quiet test job",
            JobCondition::WhileIdle,
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

    busy.send_replace(0);
    tokio::time::timeout(RUN_BOUND, quiet_job_ran)
        .await
        .expect("the parked job runs once the count is zero")
        .expect("the job reports its run");
    assert_eq!(quiet_count.load(Ordering::Relaxed), 1);
    scheduler.stop().await.expect("the task ends");
}

// A count that rises while an earlier job of the same drain runs parks the job after it, which
// runs once the count falls to zero. Killed by the count read once per drain, which runs it beside
// the busy work.
#[tokio::test(start_paused = true)]
async fn a_count_rising_mid_drain_parks_the_jobs_after_it() {
    let (busy, busy_count) = watch::channel(0);
    let busy = Arc::new(busy);
    let scheduler = Scheduler::start(Arc::new(TestWallClock::default()), None, busy_count);
    let (busy_started, busy_job_ran) = oneshot::channel();
    let raised = Arc::clone(&busy);
    let mut busy_started = Some(busy_started);
    let _busy = scheduler
        .schedule(
            "busy test job",
            JobCondition::Always,
            Duration::ZERO,
            move |_| {
                raised.send_replace(1);
                let busy_started = busy_started.take();
                Box::pin(async move {
                    if let Some(busy_started) = busy_started {
                        busy_started
                            .send(())
                            .expect("the test waits for the busy job");
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
            "quiet test job",
            JobCondition::WhileIdle,
            Duration::ZERO,
            reporting_job(quiet_ran, &quiet_count),
        )
        .expect("the job is scheduled");

    tokio::time::timeout(RUN_BOUND, busy_job_ran)
        .await
        .expect("the busy job runs")
        .expect("the busy job reports its run");
    tokio::time::sleep(IDLE_SPAN).await;
    assert_eq!(quiet_count.load(Ordering::Relaxed), 0);

    busy.send_replace(0);
    tokio::time::timeout(RUN_BOUND, quiet_job_ran)
        .await
        .expect("the parked job runs once the count is zero")
        .expect("the job reports its run");
    scheduler.stop().await.expect("the task ends");
}

// A job bounded 25 hours ahead on the wall clock runs once that clock reaches the bound though the
// busy count is still above zero, and not before, however long tokio's clock, which stops in
// sleep, runs on. Killed by the bound missing, so the job waits forever, by a bound read as no wait
// at all, and by a bound kept on tokio's clock.
#[tokio::test(start_paused = true)]
async fn a_bounded_job_runs_at_its_wall_clock_bound_while_still_busy() {
    const BOUND: Duration = Duration::from_hours(25);
    let wall_clock = Arc::new(TestWallClock::default());
    let (_busy, busy_count) = watch::channel(1);
    let scheduler = Scheduler::start(wall_clock.clone(), None, busy_count.clone());
    let started_at = wall_clock.now();
    let run_count = Arc::new(AtomicUsize::new(0));
    let (ran, job_ran) = oneshot::channel();
    let _bounded = scheduler
        .schedule(
            "bounded test job",
            JobCondition::WhileIdleUntil(started_at + BOUND),
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
    assert_eq!(*busy_count.borrow(), 1);
    scheduler.stop().await.expect("the task ends");
}
