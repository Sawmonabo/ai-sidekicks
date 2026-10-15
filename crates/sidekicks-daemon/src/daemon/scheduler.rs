//! The service's one scheduler: every background job runs from one task, one at a time, in the
//! order it falls due.
//!
//! - A job set a delay away runs at a deadline on tokio's monotonic clock, the one its timer sleeps
//!   on, so setting the wall clock back or forward neither holds it back nor runs it early.
//! - A job set for an instant on the wall clock runs at that instant through the wall clock's own
//!   timer, the operating system's, which fires at it across sleep and across any change to the
//!   clock; the timer is armed for the first such instant as it is scheduled, and when it fires
//!   every such job whose instant that clock has reached runs, and the timer is armed for the next.
//! - The wake signal is the operating system's own resume event, which every receiver hears once.
//! - While no job is pending nothing is armed and no clock is read; otherwise only the first
//!   deadline and the first instant are.

use std::collections::BTreeMap;
use std::error::Error;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::{Duration, SystemTime};

use futures::future::BoxFuture;
use sidekicks_platforms::{WakeWatch, WakeWatchError, WallClock};
use tokio::sync::{Notify, broadcast};
use tokio::task::{JoinError, JoinHandle};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

// Wakes a receiver may fall behind before it reads a lag; wakes are rare.
const WAKE_SIGNAL_CAPACITY: usize = 16;

/// What one run of a job ends with; a failure is written to the service log.
pub(crate) type ScheduledJobOutcome = Result<(), Box<dyn Error + Send + Sync>>;

// A job's work, given the token the scheduler's stop cancels, which a long job checks between its
// steps so the stop never waits on it for long.
type ScheduledJobRun =
    Box<dyn FnMut(CancellationToken) -> BoxFuture<'static, ScheduledJobOutcome> + Send>;

/// One wake of the machine from sleep, as the operating system announced it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct WakeSignal;

/// Why a job could not be scheduled.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ScheduleError {
    /// The scheduler has stopped.
    #[error("the scheduler has stopped, so the job \"{job}\" cannot be scheduled")]
    Stopped {
        /// The job's name, as the service log names it.
        job: &'static str,
    },
    /// The operating system refused to arm the wall-clock timer for the job's instant.
    #[error("the wall-clock timer could not be armed for the job \"{job}\"")]
    TimerNotArmed {
        /// The job's name, as the service log names it.
        job: &'static str,
        /// The system's refusal.
        #[source]
        source: io::Error,
    },
}

/// What a caller holds for a scheduled job.
pub(crate) struct ScheduledJobHandle {
    scheduler: Weak<SchedulerShared>,
    job_id: u64,
    is_canceled: Arc<AtomicBool>,
}

/// The daemon's one scheduler and its wake signal: jobs run one at a time in the order they fall
/// due, and a job scheduled after [`Scheduler::stop`] is refused.
pub(crate) struct Scheduler {
    shared: Arc<SchedulerShared>,
    task: Mutex<Option<JoinHandle<()>>>,
}

// What the scheduler's task and its callers share.
struct SchedulerShared {
    // The wall clock a job's instant is compared with and the timer armed on it.
    wall_clock: Arc<dyn WallClock>,
    state: Mutex<SchedulerState>,
    // Told whenever the pending runs change, so the task arms again.
    head_changed: Notify,
    // Canceled at the stop, so the job running then ends early.
    stop: CancellationToken,
}

struct SchedulerState {
    // Ordered by deadline, then by scheduling order, so the first entry is always the next due.
    pending_by_deadline: BTreeMap<(Instant, u64), PendingRun>,
    // Ordered by wall-clock instant, then by scheduling order.
    pending_by_instant: BTreeMap<(SystemTime, u64), PendingRun>,
    next_sequence: u64,
    next_job_id: u64,
    // The instant the wall-clock timer holds.
    armed_instant: Option<SystemTime>,
    is_stopped: bool,
    // Dropped at the stop, or once wakes are no longer heard, which closes every receiver.
    wake_sender: Option<broadcast::Sender<WakeSignal>>,
}

// When a run falls due: a deadline on tokio's monotonic clock or an instant on the wall clock.
#[derive(Clone, Copy)]
enum RunDue {
    Deadline(Instant),
    WallClockInstant(SystemTime),
}

struct PendingRun {
    job_id: u64,
    name: &'static str,
    run: ScheduledJobRun,
    // For a repeating job, the wait after each run ends before the next.
    repeat_interval: Option<Duration>,
    // Set, under the state's lock, by the job's cancel, so a run going then does not arm again.
    is_canceled: Arc<AtomicBool>,
}

// What ended one of the task's waits, other than the stop and a change to the pending runs.
enum SchedulerEvent {
    DeadlineReached,
    WallClockTimerFired(io::Result<()>),
    MachineWoke(Result<(), WakeWatchError>),
}

impl Scheduler {
    /// Starts the scheduler's one task on the running tokio runtime, running a wall-clock job on
    /// `wall_clock`'s timer and telling each wake `wake_watch` hears; with no watch, receivers hear
    /// no wake.
    pub(crate) fn start(wall_clock: Arc<dyn WallClock>, wake_watch: Option<WakeWatch>) -> Self {
        let state = SchedulerState {
            pending_by_deadline: BTreeMap::new(),
            pending_by_instant: BTreeMap::new(),
            next_sequence: 0,
            next_job_id: 0,
            armed_instant: None,
            is_stopped: false,
            wake_sender: Some(broadcast::channel(WAKE_SIGNAL_CAPACITY).0),
        };
        let shared = Arc::new(SchedulerShared {
            wall_clock,
            state: Mutex::new(state),
            head_changed: Notify::new(),
            stop: CancellationToken::new(),
        });
        let task = tokio::spawn(Arc::clone(&shared).run(wake_watch));
        Self {
            shared,
            task: Mutex::new(Some(task)),
        }
    }

    /// Schedules one run of `run`, named `name` in the service log, `delay` from now on the
    /// monotonic clock; a zero delay runs it at once. Refused once the scheduler has stopped.
    pub(crate) fn schedule<Run>(
        &self,
        name: &'static str,
        delay: Duration,
        run: Run,
    ) -> Result<ScheduledJobHandle, ScheduleError>
    where
        Run: FnMut(CancellationToken) -> BoxFuture<'static, ScheduledJobOutcome> + Send + 'static,
    {
        self.add(
            name,
            RunDue::Deadline(Instant::now() + delay),
            None,
            Box::new(run),
        )
    }

    /// Schedules one run of `run` at `instant` on the wall clock, which it reaches across sleep and
    /// clock changes; an instant already past runs it at once. Refused once the scheduler has
    /// stopped, or when the operating system refuses to arm the timer for it.
    pub(crate) fn schedule_at<Run>(
        &self,
        name: &'static str,
        instant: SystemTime,
        run: Run,
    ) -> Result<ScheduledJobHandle, ScheduleError>
    where
        Run: FnMut(CancellationToken) -> BoxFuture<'static, ScheduledJobOutcome> + Send + 'static,
    {
        self.add(name, RunDue::WallClockInstant(instant), None, Box::new(run))
    }

    /// Schedules `run` `first_delay` from now, then again `interval` after each run ends, so two
    /// runs of one job never overlap. Refused once the scheduler has stopped.
    pub(crate) fn schedule_repeating<Run>(
        &self,
        name: &'static str,
        interval: Duration,
        first_delay: Duration,
        run: Run,
    ) -> Result<ScheduledJobHandle, ScheduleError>
    where
        Run: FnMut(CancellationToken) -> BoxFuture<'static, ScheduledJobOutcome> + Send + 'static,
    {
        self.add(
            name,
            RunDue::Deadline(Instant::now() + first_delay),
            Some(interval),
            Box::new(run),
        )
    }

    /// A receiver of every wake from now on; dropping it detaches. Once the scheduler has stopped,
    /// or wakes are no longer heard, the receiver is closed, since no wake comes again.
    pub(crate) fn on_wake(&self) -> broadcast::Receiver<WakeSignal> {
        self.shared
            .lock_state()
            .wake_sender
            .as_ref()
            .map_or_else(|| broadcast::channel(1).1, broadcast::Sender::subscribe)
    }

    /// Runs nothing more: drops every pending run, closes the wake receivers, cancels the token
    /// the running job was given, then waits for it. Fails only when the task panicked.
    pub(crate) async fn stop(&self) -> Result<(), JoinError> {
        let (pending_by_deadline, pending_by_instant, wake_sender) = {
            let mut state = self.shared.lock_state();
            state.is_stopped = true;
            (
                std::mem::take(&mut state.pending_by_deadline),
                std::mem::take(&mut state.pending_by_instant),
                state.wake_sender.take(),
            )
        };
        self.shared.stop.cancel();
        // Dropped outside the lock, since a job's work may hold anything.
        drop(pending_by_deadline);
        drop(pending_by_instant);
        drop(wake_sender);
        let task = self
            .task
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        match task {
            Some(task) => task.await,
            None => Ok(()),
        }
    }

    fn add(
        &self,
        name: &'static str,
        due: RunDue,
        repeat_interval: Option<Duration>,
        run: ScheduledJobRun,
    ) -> Result<ScheduledJobHandle, ScheduleError> {
        let is_canceled = Arc::new(AtomicBool::new(false));
        let mut state = self.shared.lock_state();
        if state.is_stopped {
            return Err(ScheduleError::Stopped { job: name });
        }
        let job_id = state.next_job_id;
        state.next_job_id += 1;
        let sequence = state.insert(
            due,
            PendingRun {
                job_id,
                name,
                run,
                repeat_interval,
                is_canceled: Arc::clone(&is_canceled),
            },
        );
        if let RunDue::WallClockInstant(instant) = due
            && let Err(source) = self.shared.arm_first_instant(&mut state)
        {
            let refused = state.pending_by_instant.remove(&(instant, sequence));
            drop(state);
            // Dropped outside the lock, since a job's work may hold anything.
            drop(refused);
            return Err(ScheduleError::TimerNotArmed { job: name, source });
        }
        drop(state);
        self.shared.head_changed.notify_one();
        Ok(ScheduledJobHandle {
            scheduler: Arc::downgrade(&self.shared),
            job_id,
            is_canceled,
        })
    }
}

impl Drop for Scheduler {
    // A scheduler dropped without a stop still ends its task.
    fn drop(&mut self) {
        self.shared.stop.cancel();
    }
}

impl ScheduledJobHandle {
    /// Removes the job's future runs; a run already going finishes. A repeat does nothing.
    pub(crate) fn cancel(&self) {
        let Some(shared) = self.scheduler.upgrade() else {
            return;
        };
        let mut state = shared.lock_state();
        self.is_canceled.store(true, Ordering::Relaxed);
        let pending_count = state.pending_by_deadline.len() + state.pending_by_instant.len();
        state
            .pending_by_deadline
            .retain(|_, pending| pending.job_id != self.job_id);
        state
            .pending_by_instant
            .retain(|_, pending| pending.job_id != self.job_id);
        let was_pending =
            state.pending_by_deadline.len() + state.pending_by_instant.len() < pending_count;
        drop(state);
        if was_pending {
            shared.head_changed.notify_one();
        }
    }
}

impl SchedulerState {
    // Adds a pending run, returning its place in the scheduling order.
    fn insert(&mut self, due: RunDue, pending: PendingRun) -> u64 {
        let sequence = self.next_sequence;
        self.next_sequence += 1;
        match due {
            RunDue::Deadline(deadline) => {
                self.pending_by_deadline
                    .insert((deadline, sequence), pending);
            }
            RunDue::WallClockInstant(instant) => {
                self.pending_by_instant.insert((instant, sequence), pending);
            }
        }
        sequence
    }
}

impl SchedulerShared {
    fn lock_state(&self) -> MutexGuard<'_, SchedulerState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    // Arms the wall-clock timer for the first pending instant, or disarms it when none is pending.
    // On a refusal the timer keeps what it held.
    fn arm_first_instant(&self, state: &mut SchedulerState) -> io::Result<()> {
        let first_instant = state
            .pending_by_instant
            .first_key_value()
            .map(|(&(instant, _), _)| instant);
        if first_instant == state.armed_instant {
            return Ok(());
        }
        match first_instant {
            Some(instant) => self.wall_clock.arm(instant)?,
            None => self.wall_clock.disarm()?,
        }
        state.armed_instant = first_instant;
        Ok(())
    }

    // The task: sleeps until the first deadline, waits on the wall-clock timer, and hears the
    // machine's wakes, until the stop.
    async fn run(self: Arc<Self>, mut wake_watch: Option<WakeWatch>) {
        loop {
            let first_deadline = {
                let mut state = self.lock_state();
                // A run or a cancel may have changed the first instant. A refusal here has no
                // caller to answer, so it is logged and the arm is tried again at the next turn.
                if let Err(failure) = self.arm_first_instant(&mut state) {
                    tracing::error!(
                        error = &failure as &(dyn Error + 'static),
                        "The wall-clock timer could not be armed"
                    );
                }
                state
                    .pending_by_deadline
                    .first_key_value()
                    .map(|(&(deadline, _), _)| deadline)
            };
            let event = tokio::select! {
                biased;
                () = self.stop.cancelled() => return,
                () = self.head_changed.notified() => continue,
                () = sleep_until_deadline(first_deadline) => SchedulerEvent::DeadlineReached,
                fired = self.wall_clock.wait() => SchedulerEvent::WallClockTimerFired(fired),
                woke = wait_for_wake(wake_watch.as_mut()) => SchedulerEvent::MachineWoke(woke),
            };
            match event {
                SchedulerEvent::DeadlineReached => {}
                SchedulerEvent::WallClockTimerFired(fired) => {
                    if let Err(failure) = fired {
                        tracing::error!(
                            error = &failure as &(dyn Error + 'static),
                            "The wall-clock timer could not be read"
                        );
                    }
                    // A firing spends the instant, so the timer is armed again from the clock.
                    self.lock_state().armed_instant = None;
                }
                SchedulerEvent::MachineWoke(Ok(())) => self.send_wake(),
                SchedulerEvent::MachineWoke(Err(failure)) => {
                    tracing::warn!(
                        error = &failure as &(dyn Error + 'static),
                        "The machine's wakes are no longer heard"
                    );
                    wake_watch = None;
                    // Dropped outside the lock, which closes every receiver.
                    let wake_sender = self.lock_state().wake_sender.take();
                    drop(wake_sender);
                }
            }
            self.drain_due_runs().await;
        }
    }

    async fn drain_due_runs(&self) {
        while let Some(mut due) = self.take_due_run() {
            if let Err(failure) = (due.run)(self.stop.clone()).await {
                tracing::warn!(
                    job = due.name,
                    error = &*failure as &(dyn Error + 'static),
                    "A scheduled job failed"
                );
            }
            self.arm_again(due);
        }
    }

    // Takes the first pending run that is due while the scheduler still runs; the wall clock is
    // read only while a wall-clock run is pending.
    fn take_due_run(&self) -> Option<PendingRun> {
        let mut state = self.lock_state();
        if state.is_stopped {
            return None;
        }
        if let Some((&(deadline, _), _)) = state.pending_by_deadline.first_key_value()
            && deadline <= Instant::now()
        {
            return state.pending_by_deadline.pop_first().map(|(_, due)| due);
        }
        let (&(instant, _), _) = state.pending_by_instant.first_key_value()?;
        if instant > self.wall_clock.now() {
            return None;
        }
        state.pending_by_instant.pop_first().map(|(_, due)| due)
    }

    // Schedules a repeating job's next run `interval` after this one ended, unless it was canceled
    // or the scheduler stopped meanwhile.
    fn arm_again(&self, due: PendingRun) {
        let Some(interval) = due.repeat_interval else {
            return;
        };
        let deadline = Instant::now() + interval;
        let mut state = self.lock_state();
        if !state.is_stopped && !due.is_canceled.load(Ordering::Relaxed) {
            state.insert(RunDue::Deadline(deadline), due);
        }
    }

    fn send_wake(&self) {
        let state = self.lock_state();
        if let Some(sender) = &state.wake_sender {
            // A send fails only when no receiver is attached, and then no one waits for the wake.
            let _unheard = sender.send(WakeSignal);
        }
    }
}

// Sleeps until `deadline`, or forever when there is none.
async fn sleep_until_deadline(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

// Waits for the machine's next wake, or forever when no watch hears them.
async fn wait_for_wake(wake_watch: Option<&mut WakeWatch>) -> Result<(), WakeWatchError> {
    match wake_watch {
        Some(wake_watch) => wake_watch.next_wake().await,
        None => std::future::pending().await,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
    use std::time::{Duration, SystemTime};

    use sidekicks_platforms::{WallClock, WallClockWait};
    use tokio::sync::{Notify, oneshot};
    use tokio::time::Instant;

    use super::Scheduler;

    // Far longer than any periodic look would wait between two looks.
    const IDLE_SPAN: Duration = Duration::from_secs(600);

    // When the test's wall clock starts, how far ahead a job's instant is, and where the clock
    // jumps to, as a sleep the tokio clock does not see would move it.
    const CLOCK_START: Duration = Duration::from_hours(500_000);
    const INSTANT_AHEAD: Duration = Duration::from_secs(3_600);
    const JUMP_AHEAD: Duration = Duration::from_secs(7_200);

    // How long the test waits for a run that must come.
    const RUN_BOUND: Duration = Duration::from_secs(5);

    // A wall clock the test sets, whose timer fires once the clock reaches the armed instant, and
    // which counts the scheduler's waits on it, one per turn of its task.
    struct TestWallClock {
        now: Mutex<SystemTime>,
        armed_instant: Mutex<Option<SystemTime>>,
        fired: Notify,
        wait_count: AtomicUsize,
    }

    impl TestWallClock {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                now: Mutex::new(SystemTime::UNIX_EPOCH + CLOCK_START),
                armed_instant: Mutex::new(None),
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

    fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
        mutex.lock().unwrap_or_else(PoisonError::into_inner)
    }

    #[tokio::test(start_paused = true)]
    async fn an_idle_scheduler_arms_nothing_and_turns_no_more() {
        let wall_clock = TestWallClock::new();
        let scheduler = Scheduler::start(wall_clock.clone(), None);
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
        let scheduler = Scheduler::start(wall_clock.clone(), None);
        let run_count = Arc::new(AtomicUsize::new(0));
        let counted_runs = Arc::clone(&run_count);
        let (ran, wall_clock_job_ran) = oneshot::channel();
        let mut ran = Some(ran);
        scheduler
            .schedule_at(
                "wall-clock test job",
                wall_clock.now() + INSTANT_AHEAD,
                move |_| {
                    counted_runs.fetch_add(1, Ordering::Relaxed);
                    let ran = ran.take();
                    Box::pin(async move {
                        if let Some(ran) = ran {
                            ran.send(()).expect("the test waits for the run");
                        }
                        Ok(())
                    })
                },
            )
            .expect("the job is scheduled");
        // A job due now makes the task look at what is due while the instant is still ahead.
        let (looked, looked_at_due_runs) = oneshot::channel();
        let mut looked = Some(looked);
        scheduler
            .schedule("due-now test job", Duration::ZERO, move |_| {
                let looked = looked.take();
                Box::pin(async move {
                    if let Some(looked) = looked {
                        looked.send(()).expect("the test waits for the look");
                    }
                    Ok(())
                })
            })
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
}
