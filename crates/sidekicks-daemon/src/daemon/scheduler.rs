//! The service's one scheduler: every background job runs at a deadline on the monotonic clock, all
//! of them behind one task's one timer, one job at a time in deadline order.
//!
//! - A deadline is kept on the monotonic clock and checked again each time the timer fires, so
//!   setting the wall clock back or forward neither holds a job back nor runs it early. tokio's
//!   clock stops while the machine sleeps, so time asleep does not count toward a deadline; the
//!   wake signal tells the jobs that must catch up.
//! - The wake signal: when more wall-clock time than the wake gap passed between arming the timer
//!   and its firing, or the wall clock has moved that much further than the monotonic clock since
//!   the last look, the machine slept (or its clock was set forward, or the runtime was held that
//!   long), and every receiver hears it once.
//! - The timer is never armed further ahead than the wake check, so a wake is noticed within it
//!   even while no job is due; with no job and no receiver the task waits for a change alone.

use std::collections::BTreeMap;
use std::error::Error;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::{Duration, SystemTime};

use futures::future::BoxFuture;
use tokio::sync::{Notify, broadcast};
use tokio::task::{JoinError, JoinHandle};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

/// The longest the timer waits before the scheduler looks at the wall clock again, which bounds how
/// late a wake is noticed: 15 seconds, so a wake is heard within moments at little cost.
pub(crate) const WAKE_CHECK_INTERVAL: Duration = Duration::from_secs(15);

/// The wall-clock gap past which a wake is counted: one and a half wake checks, so a timer that
/// fires a little late is not taken for a sleep.
pub(crate) const WAKE_GAP_THRESHOLD: Duration = Duration::from_millis(22_500);

// Wakes a receiver may fall behind before it reads a lag; wakes are rare.
const WAKE_SIGNAL_CAPACITY: usize = 16;

/// What one run of a job ends with; a failure is written to the service log.
pub(crate) type ScheduledJobOutcome = Result<(), Box<dyn Error + Send + Sync>>;

/// A job's work, given the token the scheduler's stop cancels, which a long job checks between
/// its steps so the stop never waits on it for long.
pub(crate) type ScheduledJobRun =
    Box<dyn FnMut(CancellationToken) -> BoxFuture<'static, ScheduledJobOutcome> + Send>;

/// One wake: when it was noticed and the wall-clock gap that marked it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct WakeSignal {
    /// The wall-clock time the scheduler noticed the wake.
    pub(crate) noticed_at: SystemTime,
    /// How long the process was away, on the wall clock.
    pub(crate) away: Duration,
}

/// The clocks the scheduler runs on, injectable so a test can stand a sleep in.
#[derive(Clone)]
pub(crate) struct SchedulerClocks {
    /// The wall clock; `SystemTime::now` by default.
    pub(crate) wall_now: Arc<dyn Fn() -> SystemTime + Send + Sync>,
    /// The monotonic clock deadlines are kept on; tokio's `Instant::now` by default.
    pub(crate) monotonic_now: Arc<dyn Fn() -> Instant + Send + Sync>,
}

impl Default for SchedulerClocks {
    fn default() -> Self {
        Self {
            wall_now: Arc::new(SystemTime::now),
            monotonic_now: Arc::new(Instant::now),
        }
    }
}

/// The refusal to schedule a job once the scheduler has stopped.
#[derive(Debug, thiserror::Error)]
#[error("The scheduler has stopped, so the job \"{job}\" cannot be scheduled")]
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

/// The daemon's one scheduler and its wake signal: jobs run one at a time in deadline order, and a
/// job scheduled after [`Scheduler::stop`] is refused.
pub(crate) struct Scheduler {
    shared: Arc<SchedulerShared>,
    task: Mutex<Option<JoinHandle<()>>>,
}

// What the scheduler's task and its callers share.
struct SchedulerShared {
    clocks: SchedulerClocks,
    state: Mutex<SchedulerState>,
    // Told whenever the pending runs or the wake receivers change, so the task arms again.
    head_changed: Notify,
    // Canceled at the stop, so the job running then ends early.
    stop: CancellationToken,
}

struct SchedulerState {
    // Ordered by deadline, then by scheduling order, so the first entry is always the next due run.
    pending: BTreeMap<(Instant, u64), PendingRun>,
    next_sequence: u64,
    next_job_id: u64,
    is_stopped: bool,
    // Dropped at the stop, which closes every receiver.
    wake_sender: Option<broadcast::Sender<WakeSignal>>,
    last_wall_look: SystemTime,
    last_monotonic_look: Instant,
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

impl Scheduler {
    /// Starts the scheduler's one task on the current tokio runtime, which must be running.
    pub(crate) fn start(clocks: SchedulerClocks) -> Self {
        let state = SchedulerState {
            pending: BTreeMap::new(),
            next_sequence: 0,
            next_job_id: 0,
            is_stopped: false,
            wake_sender: Some(broadcast::channel(WAKE_SIGNAL_CAPACITY).0),
            last_wall_look: (clocks.wall_now)(),
            last_monotonic_look: (clocks.monotonic_now)(),
        };
        let shared = Arc::new(SchedulerShared {
            clocks,
            state: Mutex::new(state),
            head_changed: Notify::new(),
            stop: CancellationToken::new(),
        });
        let task = tokio::spawn(Arc::clone(&shared).run());
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
    ) -> Result<ScheduledJobHandle, SchedulerStoppedError>
    where
        Run: FnMut(CancellationToken) -> BoxFuture<'static, ScheduledJobOutcome> + Send + 'static,
    {
        self.add(name, delay, None, Box::new(run))
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
        self.add(name, first_delay, Some(interval), Box::new(run))
    }

    /// A receiver of every wake from now on; dropping it detaches. Once the scheduler has stopped
    /// the receiver is closed, since no wake comes again.
    pub(crate) fn on_wake(&self) -> broadcast::Receiver<WakeSignal> {
        let receiver = self
            .shared
            .lock_state()
            .wake_sender
            .as_ref()
            .map_or_else(|| broadcast::channel(1).1, broadcast::Sender::subscribe);
        // A receiver makes the task look at the clocks even while no job is due.
        self.shared.head_changed.notify_one();
        receiver
    }

    /// Runs nothing more: drops every pending run, closes the wake receivers, cancels the token
    /// the running job was given, then waits for it. Fails only when the task panicked.
    pub(crate) async fn stop(&self) -> Result<(), JoinError> {
        let (pending, wake_sender) = {
            let mut state = self.shared.lock_state();
            state.is_stopped = true;
            (std::mem::take(&mut state.pending), state.wake_sender.take())
        };
        self.shared.stop.cancel();
        // Dropped outside the lock, since a job's work may hold anything.
        drop(pending);
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
        delay: Duration,
        repeat_interval: Option<Duration>,
        run: ScheduledJobRun,
    ) -> Result<ScheduledJobHandle, SchedulerStoppedError> {
        let run_at = (self.shared.clocks.monotonic_now)() + delay;
        let is_canceled = Arc::new(AtomicBool::new(false));
        let job_id = {
            let mut state = self.shared.lock_state();
            if state.is_stopped {
                return Err(SchedulerStoppedError { job: name });
            }
            let job_id = state.next_job_id;
            state.next_job_id += 1;
            state.insert(
                run_at,
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
        let pending_count = state.pending.len();
        state
            .pending
            .retain(|_, pending| pending.job_id != self.job_id);
        let was_pending = state.pending.len() < pending_count;
        drop(state);
        if was_pending {
            shared.head_changed.notify_one();
        }
    }
}

impl SchedulerState {
    fn insert(&mut self, run_at: Instant, pending: PendingRun) {
        let sequence = self.next_sequence;
        self.next_sequence += 1;
        self.pending.insert((run_at, sequence), pending);
    }
}

impl SchedulerShared {
    fn lock_state(&self) -> MutexGuard<'_, SchedulerState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    // The task: arms one timer for the next due run or the next wake check, whichever is sooner,
    // and arms it again whenever the pending runs change, until the stop.
    async fn run(self: Arc<Self>) {
        loop {
            let deadline = self.next_deadline();
            let armed_at_wall = (self.clocks.wall_now)();
            let timer = async move {
                match deadline {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                biased;
                () = self.stop.cancelled() => return,
                () = self.head_changed.notified() => continue,
                () = timer => {}
            }
            // A wall clock set back reads as no gap.
            let timer_gap = (self.clocks.wall_now)()
                .duration_since(armed_at_wall)
                .unwrap_or_default();
            self.look_for_wake(timer_gap);
            self.drain_due_runs().await;
        }
    }

    // When the first run is due, never later than the next wake check; `None` when no run is
    // pending and no one receives wakes, so the task waits for a change alone.
    fn next_deadline(&self) -> Option<Instant> {
        let state = self.lock_state();
        let is_heard = state
            .wake_sender
            .as_ref()
            .is_some_and(|sender| sender.receiver_count() > 0);
        let wake_check = (self.clocks.monotonic_now)() + WAKE_CHECK_INTERVAL;
        match state.pending.first_key_value() {
            Some((&(run_at, _), _)) => Some(run_at.min(wake_check)),
            None if is_heard => Some(wake_check),
            None => None,
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
            // A long run can span a sleep, so the clocks are compared again before the next one.
            self.look_for_wake(Duration::ZERO);
        }
    }

    // Takes the first pending run when it is due and the scheduler still runs.
    fn take_due_run(&self) -> Option<PendingRun> {
        let mut state = self.lock_state();
        if state.is_stopped {
            return None;
        }
        let (&(run_at, _), _) = state.pending.first_key_value()?;
        if run_at > (self.clocks.monotonic_now)() {
            return None;
        }
        state.pending.pop_first().map(|(_, due)| due)
    }

    // Schedules a repeating job's next run `interval` after this one ended, unless it was canceled
    // or the scheduler stopped meanwhile.
    fn arm_again(&self, due: PendingRun) {
        let Some(interval) = due.repeat_interval else {
            return;
        };
        let run_at = (self.clocks.monotonic_now)() + interval;
        let mut state = self.lock_state();
        if !state.is_stopped && !due.is_canceled.load(Ordering::Relaxed) {
            state.insert(run_at, due);
        }
    }

    // `timer_gap` is the wall-clock time between arming the timer and its firing; the timer is
    // never armed for longer than a wake check, so a gap past the threshold is time the process
    // missed.
    fn look_for_wake(&self, timer_gap: Duration) {
        let wall_now = (self.clocks.wall_now)();
        let monotonic_now = (self.clocks.monotonic_now)();
        let mut state = self.lock_state();
        let monotonic_elapsed = monotonic_now.saturating_duration_since(state.last_monotonic_look);
        // A wall clock set back reads as no gap.
        let clock_gap = wall_now
            .duration_since(state.last_wall_look)
            .unwrap_or_default()
            .saturating_sub(monotonic_elapsed);
        state.last_wall_look = wall_now;
        state.last_monotonic_look = monotonic_now;
        let away = timer_gap.max(clock_gap);
        if away <= WAKE_GAP_THRESHOLD {
            return;
        }
        let Some(sender) = &state.wake_sender else {
            return;
        };
        let wake = WakeSignal {
            noticed_at: wall_now,
            away,
        };
        // A send fails only when no receiver is attached, and then no one waits for the wake.
        if sender.send(wake).is_err() {
            tracing::debug!(away = ?away, "a wake was noticed with no one listening");
        }
    }
}
