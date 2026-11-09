//! The scheduler's order, clocks and conditions.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use futures::future::BoxFuture;
use sidekicks_platforms::WallClock;
use tokio::sync::{oneshot, watch};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::test_wall_clock::TestWallClock;
use super::{
    JobCadence, JobCondition, ScheduleError, ScheduledJobOutcome, Scheduler, SchedulerStopError,
};

// Far longer than any periodic look would wait between two looks.
const IDLE_SPAN: Duration = Duration::from_secs(600);

// How far ahead a job's instant is, and where the clock jumps to, as a sleep the tokio clock does
// not see would move it.
const INSTANT_AHEAD: Duration = Duration::from_secs(3_600);
const JUMP_AHEAD: Duration = Duration::from_secs(7_200);

// How long the test waits for a run that must come.
const RUN_BOUND: Duration = Duration::from_secs(5);

// A stop's deadline no test's task comes near.
const STOP_BOUND: Duration = Duration::from_secs(60);

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
    scheduler
        .stop(Instant::now() + STOP_BOUND)
        .await
        .expect("the task ends");
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
    scheduler
        .stop(Instant::now() + STOP_BOUND)
        .await
        .expect("the task ends");
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
    scheduler
        .stop(Instant::now() + STOP_BOUND)
        .await
        .expect("the task ends");
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
    scheduler
        .stop(Instant::now() + STOP_BOUND)
        .await
        .expect("the task ends");
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
    scheduler
        .stop(Instant::now() + STOP_BOUND)
        .await
        .expect("the task ends");
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
    scheduler
        .stop(Instant::now() + STOP_BOUND)
        .await
        .expect("the task ends");
}

// A job held for a backup copy's ten-minute lock bound holds no timer: a timer due one second in
// runs at its own deadline while the job is still held, so its lateness is zero where a job awaited
// on the scheduler's task makes it ten minutes late. Killed by the job awaited inline on the
// scheduler's task.
#[tokio::test(start_paused = true)]
async fn a_running_job_holds_no_timer() {
    const JOB_LENGTH: Duration = Duration::from_mins(10);
    const TIMER_DELAY: Duration = Duration::from_secs(1);
    let scheduler = Scheduler::start(
        Arc::new(TestWallClock::default()),
        None,
        watch::channel(0).1,
    );
    let (started, job_started) = oneshot::channel();
    let (ended, job_ended) = oneshot::channel();
    let mut job = Some((started, ended));
    let _held = scheduler
        .schedule_job(
            "held test job",
            JobCondition::Always,
            JobCadence::Delay(Duration::ZERO),
            move |_token| {
                let (started, ended) = job.take().expect("the job runs once");
                Box::pin(async move {
                    started.send(()).expect("the test waits for the start");
                    tokio::time::sleep(JOB_LENGTH).await;
                    ended.send(()).expect("the test waits for the end");
                    Ok(())
                })
            },
        )
        .expect("the job is scheduled");
    tokio::time::timeout(RUN_BOUND, job_started)
        .await
        .expect("the job starts")
        .expect("the job reports its start");

    let deadline = Instant::now() + TIMER_DELAY;
    let (ran, timer_ran) = oneshot::channel();
    let _timer = scheduler
        .schedule(
            "test timer",
            JobCondition::Always,
            TIMER_DELAY,
            reporting_job(ran, &Arc::new(AtomicUsize::new(0))),
        )
        .expect("the timer is scheduled");
    tokio::time::timeout(RUN_BOUND, timer_ran)
        .await
        .expect("the timer runs while the job is held")
        .expect("the timer reports its run");
    let lateness = Instant::now() - deadline;
    assert_eq!(
        lateness,
        Duration::ZERO,
        "the timer ran at its own deadline"
    );

    tokio::time::timeout(JOB_LENGTH, job_ended)
        .await
        .expect("the job ends after its length")
        .expect("the job reports its end");
    scheduler
        .stop(Instant::now() + STOP_BOUND)
        .await
        .expect("the task ends");
}

// Jobs run one at a time, each under the busy count as it stands when it is taken: a job waiting
// for idle that falls due while another job is held does not start, and once the count rises and
// the held job ends it still waits, starting only once the count falls to zero. Killed by a task
// spawned per job with no queue, which runs the two at once, and by a queued job's condition read
// when it fell due, which starts it while the count is up.
#[tokio::test(start_paused = true)]
async fn jobs_run_one_at_a_time_each_under_the_count_when_taken() {
    let (busy, busy_count) = watch::channel(0);
    let scheduler = Scheduler::start(Arc::new(TestWallClock::default()), None, busy_count);
    let (started, held_started) = oneshot::channel();
    let (release, released) = oneshot::channel::<()>();
    let mut held = Some((started, released));
    let _held = scheduler
        .schedule_job(
            "held test job",
            JobCondition::Always,
            JobCadence::Delay(Duration::ZERO),
            move |_token| {
                let (started, released) = held.take().expect("the job runs once");
                Box::pin(async move {
                    started.send(()).expect("the test waits for the start");
                    released.await.expect("the test releases the job");
                    Ok(())
                })
            },
        )
        .expect("the job is scheduled");
    tokio::time::timeout(RUN_BOUND, held_started)
        .await
        .expect("the held job starts")
        .expect("the held job reports its start");
    let quiet_count = Arc::new(AtomicUsize::new(0));
    let (quiet_ran, quiet_job_ran) = oneshot::channel();
    let _quiet = scheduler
        .schedule_job(
            "quiet test job",
            JobCondition::WhileIdle,
            JobCadence::Delay(Duration::ZERO),
            reporting_job(quiet_ran, &quiet_count),
        )
        .expect("the job is scheduled");

    tokio::time::sleep(IDLE_SPAN).await;
    assert_eq!(
        quiet_count.load(Ordering::Relaxed),
        0,
        "one job runs at a time"
    );
    busy.send_replace(1);
    release
        .send(())
        .expect("the held job waits for its release");
    tokio::time::sleep(IDLE_SPAN).await;
    assert_eq!(
        quiet_count.load(Ordering::Relaxed),
        0,
        "the queued job reads the count as it stands when taken"
    );

    busy.send_replace(0);
    tokio::time::timeout(RUN_BOUND, quiet_job_ran)
        .await
        .expect("the queued job runs once the count is zero")
        .expect("the job reports its run");
    scheduler
        .stop(Instant::now() + STOP_BOUND)
        .await
        .expect("the task ends");
}

// A job the count releases from parking while another job runs waits behind it: it does not
// start, and the running job is not cut short, until that job ends. Killed by the released job
// taken in place of the running one, which aborts it mid-run and runs the two jobs at once.
#[tokio::test(start_paused = true)]
async fn a_job_released_from_parking_waits_for_the_running_job() {
    let (busy, busy_count) = watch::channel(1);
    let scheduler = Scheduler::start(Arc::new(TestWallClock::default()), None, busy_count);
    let quiet_count = Arc::new(AtomicUsize::new(0));
    let (quiet_ran, quiet_job_ran) = oneshot::channel();
    let _quiet = scheduler
        .schedule_job(
            "quiet test job",
            JobCondition::WhileIdle,
            JobCadence::Delay(Duration::ZERO),
            reporting_job(quiet_ran, &quiet_count),
        )
        .expect("the job is scheduled");
    let (started, held_started) = oneshot::channel();
    let (release, released) = oneshot::channel::<()>();
    let has_ended = Arc::new(AtomicBool::new(false));
    let ending = Arc::clone(&has_ended);
    let mut held = Some((started, released));
    let _held = scheduler
        .schedule_job(
            "held test job",
            JobCondition::Always,
            JobCadence::Delay(Duration::ZERO),
            move |_token| {
                let (started, released) = held.take().expect("the job runs once");
                let ending = Arc::clone(&ending);
                Box::pin(async move {
                    started.send(()).expect("the test waits for the start");
                    released.await.expect("the test releases the job");
                    ending.store(true, Ordering::Relaxed);
                    Ok(())
                })
            },
        )
        .expect("the job is scheduled");
    tokio::time::timeout(RUN_BOUND, held_started)
        .await
        .expect("the held job starts")
        .expect("the held job reports its start");
    assert_eq!(scheduler.waiting_job_names(), ["quiet test job"]);

    busy.send_replace(0);
    tokio::time::sleep(IDLE_SPAN).await;
    assert_eq!(
        quiet_count.load(Ordering::Relaxed),
        0,
        "the released job waits for the running one"
    );

    release
        .send(())
        .expect("the held job waits for its release");
    tokio::time::timeout(RUN_BOUND, quiet_job_ran)
        .await
        .expect("the released job runs once the held one ends")
        .expect("the job reports its run");
    assert!(has_ended.load(Ordering::Relaxed), "the held job's end ran");
    scheduler
        .stop(Instant::now() + STOP_BOUND)
        .await
        .expect("the task ends");
}

// A job that panics ends the scheduler's task as a timer's panic does, and the stop answers it.
// Killed by the job's panic logged and dropped, which leaves the task running and the stop `Ok`.
#[tokio::test(start_paused = true)]
async fn a_job_that_panics_ends_the_task_and_the_stop_answers_it() {
    // The job's end, typed as a run's outcome.
    fn panic_in_job() -> ScheduledJobOutcome {
        panic!("the test job panics")
    }
    let scheduler = Scheduler::start(
        Arc::new(TestWallClock::default()),
        None,
        watch::channel(0).1,
    );
    let (started, job_started) = oneshot::channel();
    let mut started = Some(started);
    let _panicking = scheduler
        .schedule_job(
            "panicking test job",
            JobCondition::Always,
            JobCadence::Delay(Duration::ZERO),
            move |_token| {
                let started = started.take().expect("the job runs once");
                Box::pin(async move {
                    started.send(()).expect("the test waits for the start");
                    panic_in_job()
                })
            },
        )
        .expect("the job is scheduled");
    tokio::time::timeout(RUN_BOUND, job_started)
        .await
        .expect("the job starts")
        .expect("the job reports its start");

    let stopped = scheduler.stop(Instant::now() + STOP_BOUND).await;
    assert!(
        matches!(stopped, Err(SchedulerStopError::Panicked(_))),
        "the stop answers the panic, not {stopped:?}"
    );
}

// A stop waits for the running job, which holds the canceled token, to end: a job that finishes
// one await after its token is canceled ends its work and the stop answers `Ok`. Killed by the task
// returning at the stop without awaiting its job, which aborts the job before its end.
#[tokio::test(start_paused = true)]
async fn a_stop_waits_for_a_running_job_that_ends_on_its_token() {
    let scheduler = Scheduler::start(
        Arc::new(TestWallClock::default()),
        None,
        watch::channel(0).1,
    );
    let (started, job_started) = oneshot::channel();
    let has_ended = Arc::new(AtomicBool::new(false));
    let ending = Arc::clone(&has_ended);
    let mut job = Some(started);
    let _job = scheduler
        .schedule_job(
            "token test job",
            JobCondition::Always,
            JobCadence::Delay(Duration::ZERO),
            move |token| {
                let started = job.take().expect("the job runs once");
                let ending = Arc::clone(&ending);
                Box::pin(async move {
                    started.send(()).expect("the test waits for the start");
                    token.cancelled().await;
                    tokio::task::yield_now().await;
                    ending.store(true, Ordering::Relaxed);
                    Ok(())
                })
            },
        )
        .expect("the job is scheduled");
    tokio::time::timeout(RUN_BOUND, job_started)
        .await
        .expect("the job starts")
        .expect("the job reports its start");

    scheduler
        .stop(Instant::now() + STOP_BOUND)
        .await
        .expect("the stop ends with the job");
    assert!(has_ended.load(Ordering::Relaxed), "the job's end ran");
}

// A timer and a job that never read their token hold the stop only to its deadline: the task is
// aborted, and the job with it, so both runs' work is dropped. The job is scheduled first, so it is
// on the job task when the stuck timer holds the scheduler's task. Killed by awaiting the task with
// no bound, which the outer bound fails, by a bound with no abort, which leaves the timer's guard
// held, and by a job task the abort does not reach, which leaves the job's guard held.
#[tokio::test(start_paused = true)]
async fn a_stop_aborts_a_timer_and_a_job_still_running_at_its_deadline() {
    let scheduler = Scheduler::start(
        Arc::new(TestWallClock::default()),
        None,
        watch::channel(0).1,
    );
    let (job_started, stuck_job_started) = oneshot::channel();
    let (job_guard, job_guard_dropped) = oneshot::channel::<()>();
    let mut job = Some((job_started, job_guard));
    let _stuck_job = scheduler
        .schedule_job(
            "stuck test job",
            JobCondition::Always,
            JobCadence::Delay(Duration::ZERO),
            move |_token| {
                let (started, guard) = job.take().expect("the job runs once");
                Box::pin(async move {
                    let _guard = guard;
                    started.send(()).expect("the test waits for the start");
                    std::future::pending::<ScheduledJobOutcome>().await
                })
            },
        )
        .expect("the job is scheduled");
    let (timer_started, stuck_timer_started) = oneshot::channel();
    let (timer_guard, timer_guard_dropped) = oneshot::channel::<()>();
    let mut timer = Some((timer_started, timer_guard));
    let _stuck_timer = scheduler
        .schedule(
            "stuck test timer",
            JobCondition::Always,
            Duration::ZERO,
            move |_token| {
                let (started, guard) = timer.take().expect("the timer runs once");
                Box::pin(async move {
                    let _guard = guard;
                    started.send(()).expect("the test waits for the start");
                    std::future::pending::<ScheduledJobOutcome>().await
                })
            },
        )
        .expect("the timer is scheduled");
    for started in [stuck_job_started, stuck_timer_started] {
        tokio::time::timeout(RUN_BOUND, started)
            .await
            .expect("the run starts")
            .expect("the run reports its start");
    }

    let stopped = tokio::time::timeout(
        RUN_BOUND,
        scheduler.stop(Instant::now() + Duration::from_millis(50)),
    )
    .await
    .expect("the stop ends at its deadline");
    assert!(matches!(stopped, Err(SchedulerStopError::Overran)));
    for guard_dropped in [timer_guard_dropped, job_guard_dropped] {
        tokio::time::timeout(RUN_BOUND, guard_dropped)
            .await
            .expect("the aborted run's work is dropped")
            .expect_err("the guard is dropped, never sent");
    }
}
