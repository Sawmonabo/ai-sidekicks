//! The service's one scheduler: every background job runs from one task, one at a time, in the
//! order it falls due.
//!
//! - A job set a delay away runs at a deadline on tokio's monotonic clock, the one its timer sleeps
//!   on, so setting the wall clock back or forward neither holds it back nor runs it early.
//! - A job set for an instant on the wall clock runs at that instant through the operating
//!   system's wall-clock timer, which fires at it across sleep and across any change to the clock;
//!   when the timer fires, every such job whose instant the wall clock has reached runs, and the
//!   timer is armed again for the next.
//! - The wake signal is the operating system's own resume event, which every receiver hears once.
//! - While no job is due nothing is armed and no clock is read: the task waits for a job, the
//!   operating system's timer or a wake.

use std::collections::BTreeMap;
use std::error::Error;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::{Duration, SystemTime};

use futures::future::BoxFuture;
use sidekicks_platforms::{WakeWatch, WakeWatchError, WallClockTimer};
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

/// The wall clock a job's instant is compared with once the operating system's timer fires;
/// `SystemTime::now` in the daemon, injectable for tests.
pub(crate) type WallClock = Arc<dyn Fn() -> SystemTime + Send + Sync>;

/// The refusal to schedule a job once the scheduler has stopped.
#[derive(Debug, thiserror::Error)]
#[error("the scheduler has stopped, so the job \"{job}\" cannot be scheduled")]
pub(crate) struct SchedulerStoppedError {
    /// The job's name, as the service log names it.
    pub(crate) job: &'static str,
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
    wall_now: WallClock,
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
    is_stopped: bool,
    // Dropped at the stop, which closes every receiver.
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
    /// Starts the scheduler's one task on the running tokio runtime, comparing a wall-clock job's
    /// instant with `wall_now` and telling each wake `wake_watch` hears; with no watch, receivers
    /// hear no wake. Fails when the operating system refuses the wall-clock timer.
    pub(crate) fn start(wall_now: WallClock, wake_watch: Option<WakeWatch>) -> io::Result<Self> {
        let wall_clock_timer = WallClockTimer::new()?;
        let state = SchedulerState {
            pending_by_deadline: BTreeMap::new(),
            pending_by_instant: BTreeMap::new(),
            next_sequence: 0,
            next_job_id: 0,
            is_stopped: false,
            wake_sender: Some(broadcast::channel(WAKE_SIGNAL_CAPACITY).0),
        };
        let shared = Arc::new(SchedulerShared {
            wall_now,
            state: Mutex::new(state),
            head_changed: Notify::new(),
            stop: CancellationToken::new(),
        });
        let task = tokio::spawn(Arc::clone(&shared).run(wall_clock_timer, wake_watch));
        Ok(Self {
            shared,
            task: Mutex::new(Some(task)),
        })
    }

    /// Schedules one run of `run`, named `name` in the service log, `delay` from now on the
    /// monotonic clock; a zero delay runs it at once. Refused once the scheduler has stopped.
    pub(crate) fn schedule<Run>(
        &self,
        name: &'static str,
        delay: Duration,
        run: Run,
    ) -> Result<ScheduledJobHandle, SchedulerStoppedError>
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
    /// stopped.
    pub(crate) fn schedule_at<Run>(
        &self,
        name: &'static str,
        instant: SystemTime,
        run: Run,
    ) -> Result<ScheduledJobHandle, SchedulerStoppedError>
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
    ) -> Result<ScheduledJobHandle, SchedulerStoppedError>
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

    /// A receiver of every wake from now on; dropping it detaches. Once the scheduler has stopped
    /// the receiver is closed, since no wake comes again.
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
    ) -> Result<ScheduledJobHandle, SchedulerStoppedError> {
        let is_canceled = Arc::new(AtomicBool::new(false));
        let job_id = {
            let mut state = self.shared.lock_state();
            if state.is_stopped {
                return Err(SchedulerStoppedError { job: name });
            }
            let job_id = state.next_job_id;
            state.next_job_id += 1;
            state.insert(
                due,
                PendingRun {
                    job_id,
                    name,
                    run,
                    repeat_interval,
                    is_canceled: Arc::clone(&is_canceled),
                },
            );
            job_id
        };
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
    fn insert(&mut self, due: RunDue, pending: PendingRun) {
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
    }
}

impl SchedulerShared {
    fn lock_state(&self) -> MutexGuard<'_, SchedulerState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    // The task: sleeps until the first deadline, keeps the operating system's timer armed for the
    // first wall-clock instant, and hears the machine's wakes, until the stop.
    async fn run(
        self: Arc<Self>,
        mut wall_clock_timer: WallClockTimer,
        mut wake_watch: Option<WakeWatch>,
    ) {
        let mut armed_instant = None;
        loop {
            let (first_deadline, first_instant) = self.first_due();
            if first_instant != armed_instant {
                let armed = match first_instant {
                    Some(instant) => wall_clock_timer.arm(instant),
                    None => wall_clock_timer.disarm(),
                };
                if let Err(failure) = armed {
                    tracing::error!(
                        error = &failure as &(dyn Error + 'static),
                        "The wall-clock timer could not be set"
                    );
                }
                armed_instant = first_instant;
            }
            let event = tokio::select! {
                biased;
                () = self.stop.cancelled() => return,
                () = self.head_changed.notified() => continue,
                () = sleep_until_deadline(first_deadline) => SchedulerEvent::DeadlineReached,
                fired = wait_for_timer(&mut wall_clock_timer, armed_instant.is_some()) => {
                    SchedulerEvent::WallClockTimerFired(fired)
                }
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
                    // A firing or a clock change spends the timer, so it is armed again.
                    armed_instant = None;
                }
                SchedulerEvent::MachineWoke(Ok(())) => self.send_wake(),
                SchedulerEvent::MachineWoke(Err(failure)) => {
                    tracing::warn!(
                        error = &failure as &(dyn Error + 'static),
                        "The machine's wakes are no longer heard"
                    );
                    wake_watch = None;
                }
            }
            self.drain_due_runs().await;
        }
    }

    // The first pending deadline and the first pending wall-clock instant.
    fn first_due(&self) -> (Option<Instant>, Option<SystemTime>) {
        let state = self.lock_state();
        (
            state
                .pending_by_deadline
                .first_key_value()
                .map(|(&(deadline, _), _)| deadline),
            state
                .pending_by_instant
                .first_key_value()
                .map(|(&(instant, _), _)| instant),
        )
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
        if instant > (self.wall_now)() {
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

// Waits for the wall-clock timer while it is armed, or forever when it is not.
async fn wait_for_timer(timer: &mut WallClockTimer, is_armed: bool) -> io::Result<()> {
    if is_armed {
        timer.wait().await
    } else {
        std::future::pending().await
    }
}

// Waits for the machine's next wake, or forever when no watch hears them.
async fn wait_for_wake(wake_watch: Option<&mut WakeWatch>) -> Result<(), WakeWatchError> {
    match wake_watch {
        Some(wake_watch) => wake_watch.next_wake().await,
        None => std::future::pending().await,
    }
}
