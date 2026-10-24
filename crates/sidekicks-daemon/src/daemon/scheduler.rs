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
//! - A job may run only while no run is live; one that falls due while a run is live is parked
//!   aside, so it never holds the task, and runs once the count of live runs reaches zero, or at
//!   the latest at its condition's instant on the wall clock, which the wall clock's timer fires
//!   at as it does a job's own instant. The count is read again before each run is taken, so a run
//!   that goes live while earlier jobs run parks the jobs after them.
//! - A job with a processor budget registers it with its run (`budget::metered_job`), which
//!   meters the run on its own threads and writes its processor time beside the budget.

use std::collections::BTreeMap;
use std::error::Error;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::{Duration, SystemTime};

use futures::future::BoxFuture;
use sidekicks_platforms::{WakeWatch, WakeWatchError, WallClock};
use tokio::sync::{Notify, broadcast, oneshot, watch};
use tokio::task::{JoinError, JoinHandle};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tracing::Instrument as _;

pub(crate) use crate::daemon::scheduler::condition::JobCondition;
use crate::daemon::scheduler::condition::ParkedRuns;

pub(crate) mod budget;
mod condition;

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
    // For a wall-clock job, the refusal the task sends when it cannot arm the timer for its
    // instant.
    refusal: Option<oneshot::Receiver<ScheduleError>>,
}

/// The daemon's one scheduler and its wake signal: jobs run one at a time in the order they fall
/// due, and a job scheduled after [`Scheduler::stop`] is refused.
pub struct Scheduler {
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
    // The due runs whose condition failed, waiting for no run to be live or for their bound.
    parked: ParkedRuns,
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
    // When it may run once due.
    condition: JobCondition,
    run: ScheduledJobRun,
    // For a repeating job, the wait after each run ends before the next.
    repeat_interval: Option<Duration>,
    // Set, under the state's lock, by the job's cancel, so a run going then does not arm again.
    is_canceled: Arc<AtomicBool>,
    // For a wall-clock run, where the task sends the refusal when it cannot arm the timer for it.
    refusal_sender: Option<oneshot::Sender<ScheduleError>>,
}

// What ended one of the task's waits, other than the stop and a change to the pending runs.
enum SchedulerEvent {
    DeadlineReached,
    WallClockTimerFired(io::Result<()>),
    MachineWoke(Result<(), WakeWatchError>),
    LiveRunsChanged(Result<(), watch::error::RecvError>),
}

impl Scheduler {
    /// Starts the scheduler's one task on the running tokio runtime, running a wall-clock job on
    /// `wall_clock`'s timer, telling each wake `wake_watch` hears, and reading each job's condition
    /// against `live_runs`, the count of live runs; with no watch, receivers hear no wake.
    pub fn start(
        wall_clock: Arc<dyn WallClock>,
        wake_watch: Option<WakeWatch>,
        live_runs: watch::Receiver<u32>,
    ) -> Self {
        let state = SchedulerState {
            pending_by_deadline: BTreeMap::new(),
            pending_by_instant: BTreeMap::new(),
            parked: ParkedRuns::default(),
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
        let task = tokio::spawn(Arc::clone(&shared).run(wake_watch, live_runs));
        Self {
            shared,
            task: Mutex::new(Some(task)),
        }
    }

    /// The names of the runs waiting to fall due or parked, for a test to read what was scheduled.
    #[cfg(test)]
    pub(crate) fn waiting_job_names(&self) -> Vec<&'static str> {
        let state = self.shared.lock_state();
        state
            .pending_by_deadline
            .values()
            .chain(state.pending_by_instant.values())
            .map(|run| run.name)
            .chain(state.parked.names())
            .collect()
    }

    /// Schedules one run of `run`, named `name` in the service log, `delay` from now on the
    /// monotonic clock, to run once `condition` allows; a zero delay runs it at once. Refused once
    /// the scheduler has stopped.
    pub(crate) fn schedule<Run>(
        &self,
        name: &'static str,
        condition: JobCondition,
        delay: Duration,
        run: Run,
    ) -> Result<ScheduledJobHandle, ScheduleError>
    where
        Run: FnMut(CancellationToken) -> BoxFuture<'static, ScheduledJobOutcome> + Send + 'static,
    {
        self.add(
            name,
            condition,
            RunDue::Deadline(Instant::now() + delay),
            None,
            Box::new(run),
        )
    }

    /// Schedules one run of `run` at `instant` on the wall clock, which it reaches across sleep and
    /// clock changes, to run once `condition` allows; an instant already past runs it at once.
    /// Refused once the scheduler has stopped, or when the operating system refuses to arm the
    /// timer for it.
    pub(crate) fn schedule_at<Run>(
        &self,
        name: &'static str,
        condition: JobCondition,
        instant: SystemTime,
        run: Run,
    ) -> Result<ScheduledJobHandle, ScheduleError>
    where
        Run: FnMut(CancellationToken) -> BoxFuture<'static, ScheduledJobOutcome> + Send + 'static,
    {
        self.add(
            name,
            condition,
            RunDue::WallClockInstant(instant),
            None,
            Box::new(run),
        )
    }

    /// Schedules `run` `first_delay` from now, then again `interval` after each run ends, so two
    /// runs of one job never overlap, each running once `condition` allows. Refused once the
    /// scheduler has stopped.
    pub(crate) fn schedule_repeating<Run>(
        &self,
        name: &'static str,
        condition: JobCondition,
        interval: Duration,
        first_delay: Duration,
        run: Run,
    ) -> Result<ScheduledJobHandle, ScheduleError>
    where
        Run: FnMut(CancellationToken) -> BoxFuture<'static, ScheduledJobOutcome> + Send + 'static,
    {
        self.add(
            name,
            condition,
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
        let (pending_by_deadline, pending_by_instant, parked, wake_sender) = {
            let mut state = self.shared.lock_state();
            state.is_stopped = true;
            (
                std::mem::take(&mut state.pending_by_deadline),
                std::mem::take(&mut state.pending_by_instant),
                state.parked.take_all(),
                state.wake_sender.take(),
            )
        };
        self.shared.stop.cancel();
        // Dropped outside the lock, since a job's work may hold anything.
        drop(pending_by_deadline);
        drop(pending_by_instant);
        drop(parked);
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
        condition: JobCondition,
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
        let (refusal_sender, refusal) = match due {
            RunDue::Deadline(_) => (None, None),
            RunDue::WallClockInstant(_) => {
                let (refusal_sender, refusal) = oneshot::channel();
                (Some(refusal_sender), Some(refusal))
            }
        };
        let sequence = state.insert(
            due,
            PendingRun {
                job_id,
                name,
                condition,
                run,
                repeat_interval,
                is_canceled: Arc::clone(&is_canceled),
                refusal_sender,
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
            refusal,
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
    /// Waits until the job's instant is settled: the refusal when the operating system would not
    /// arm the wall-clock timer for it, which drops the job, or `None` once it ran, was canceled or
    /// the scheduler stopped. A job set a delay away, or a second call, settles at once with
    /// `None`.
    pub(crate) async fn refusal(&mut self) -> Option<ScheduleError> {
        self.refusal.take()?.await.ok()
    }

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
        let was_parked = state.parked.cancel_job(self.job_id);
        let was_pending = was_parked
            || state.pending_by_deadline.len() + state.pending_by_instant.len() < pending_count;
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

    // Arms the wall-clock timer for the first pending instant or parked run's latest moment,
    // whichever comes first, or disarms it when there is neither. On a refusal the timer keeps what
    // it held.
    fn arm_first_instant(&self, state: &mut SchedulerState) -> io::Result<()> {
        let first_instant = state
            .pending_by_instant
            .first_key_value()
            .map(|(&(instant, _), _)| instant)
            .into_iter()
            .chain(state.parked.first_latest())
            .min();
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

    // Arms the wall-clock timer for the first pending instant. Each run whose instant the timer
    // refuses is taken out with the refusal, and the next first instant is armed in its place, so
    // no instant is left pending without the timer armed for it; a parked run whose latest moment
    // the timer refuses keeps waiting for no run to be live.
    fn arm_or_refuse_first_instants(
        &self,
        state: &mut SchedulerState,
    ) -> Vec<(PendingRun, io::Error)> {
        let mut refused_runs = Vec::new();
        while let Err(source) = self.arm_first_instant(state) {
            let first_pending = state
                .pending_by_instant
                .first_key_value()
                .map(|(&(instant, _), _)| instant);
            if let Some(latest) = state.parked.first_latest()
                && first_pending.is_none_or(|pending| latest < pending)
            {
                let job = state.parked.forget_first_latest();
                tracing::error!(
                    job,
                    error = &source as &(dyn Error + 'static),
                    "the wall-clock timer could not be armed for the job's latest moment, so it \
                     waits for no run to be live"
                );
                continue;
            }
            let Some((_, refused)) = state.pending_by_instant.pop_first() else {
                // Nothing waits on the timer, so an instant it still holds only turns the task
                // once more when it fires.
                tracing::error!(
                    error = &source as &(dyn Error + 'static),
                    "the wall-clock timer could not be disarmed"
                );
                break;
            };
            refused_runs.push((refused, source));
        }
        refused_runs
    }

    // The task: sleeps until the first deadline, waits on the wall-clock timer, hears the
    // machine's wakes and, while a run is parked, follows the count of live runs, until the stop.
    // A count whose sender is gone reads as no run live, so nothing stays parked for it.
    async fn run(
        self: Arc<Self>,
        mut wake_watch: Option<WakeWatch>,
        mut live_runs: watch::Receiver<u32>,
    ) {
        let mut is_count_followed = true;
        loop {
            let (first_deadline, is_parked, refused_runs) = {
                let mut state = self.lock_state();
                // A run or a cancel may have changed the first instant.
                let refused_runs = self.arm_or_refuse_first_instants(&mut state);
                let first_deadline = state
                    .pending_by_deadline
                    .first_key_value()
                    .map(|(&(deadline, _), _)| deadline);
                (first_deadline, !state.parked.is_empty(), refused_runs)
            };
            // Told and dropped outside the lock, since a job's work may hold anything.
            for (refused, source) in refused_runs {
                refuse_run(refused, source);
            }
            let event = tokio::select! {
                biased;
                () = self.stop.cancelled() => return,
                () = self.head_changed.notified() => continue,
                () = sleep_until_deadline(first_deadline) => SchedulerEvent::DeadlineReached,
                fired = self.wall_clock.wait() => SchedulerEvent::WallClockTimerFired(fired),
                woke = wait_for_wake(wake_watch.as_mut()) => SchedulerEvent::MachineWoke(woke),
                changed = live_runs.changed(), if is_parked && is_count_followed => {
                    SchedulerEvent::LiveRunsChanged(changed)
                }
            };
            match event {
                SchedulerEvent::DeadlineReached | SchedulerEvent::LiveRunsChanged(Ok(())) => {}
                SchedulerEvent::WallClockTimerFired(fired) => {
                    if let Err(failure) = fired {
                        tracing::error!(
                            error = &failure as &(dyn Error + 'static),
                            "the wall-clock timer could not be read"
                        );
                    }
                    // A firing spends the instant, so the timer is armed again from the clock.
                    self.lock_state().armed_instant = None;
                }
                SchedulerEvent::MachineWoke(Ok(())) => self.send_wake(),
                SchedulerEvent::MachineWoke(Err(failure)) => {
                    tracing::warn!(
                        error = &failure as &(dyn Error + 'static),
                        "the machine's wakes are no longer heard"
                    );
                    wake_watch = None;
                    // Dropped outside the lock, which closes every receiver.
                    let wake_sender = self.lock_state().wake_sender.take();
                    drop(wake_sender);
                }
                SchedulerEvent::LiveRunsChanged(Err(_closed)) => is_count_followed = false,
            }
            let live_runs = is_count_followed.then_some(&live_runs);
            self.drain_due_runs(live_runs).await;
        }
    }

    // Runs every due run its condition allows, parking each it does not, and every parked run that
    // may now go; the count of live runs is read before each take, none when it is not followed.
    async fn drain_due_runs(&self, live_runs: Option<&watch::Receiver<u32>>) {
        let live_run_count = || live_runs.map_or(0, |live_runs| *live_runs.borrow());
        while let Some(mut due) = self.take_due_run(live_run_count()) {
            let span = tracing::info_span!("scheduled job", job = due.name);
            if let Err(failure) = (due.run)(self.stop.clone()).instrument(span).await {
                tracing::warn!(
                    job = due.name,
                    error = &*failure as &(dyn Error + 'static),
                    "a scheduled job failed"
                );
            }
            self.arm_again(due);
        }
    }

    // Takes the first run that may go while the scheduler still runs: a parked run released by
    // the count or its latest moment, else the first due run its condition allows, parking each
    // due run it does not; the wall clock is read only while a wall-clock run or a parked run's
    // latest moment is pending.
    fn take_due_run(&self, live_run_count: u32) -> Option<PendingRun> {
        let mut state = self.lock_state();
        if state.is_stopped {
            return None;
        }
        let now = Instant::now();
        if let Some(released) = state
            .parked
            .take_released(live_run_count, || self.wall_clock.now())
        {
            return Some(released);
        }
        loop {
            let due = if let Some((&(deadline, _), _)) = state.pending_by_deadline.first_key_value()
                && deadline <= now
            {
                state.pending_by_deadline.pop_first()?.1
            } else {
                let (&(instant, _), _) = state.pending_by_instant.first_key_value()?;
                if instant > self.wall_clock.now() {
                    return None;
                }
                state.pending_by_instant.pop_first()?.1
            };
            if due.condition.allows(live_run_count) {
                return Some(due);
            }
            state.parked.park(due);
        }
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

// Logs a run the timer could not be armed for and tells its owner, whose handle may be gone.
fn refuse_run(refused: PendingRun, source: io::Error) {
    tracing::error!(
        job = refused.name,
        error = &source as &(dyn Error + 'static),
        "the wall-clock timer could not be armed, so the job will not run"
    );
    if let Some(refusal_sender) = refused.refusal_sender {
        // A send fails only when the handle is gone, and then no one waits for the refusal.
        let _unheard = refusal_sender.send(ScheduleError::TimerNotArmed {
            job: refused.name,
            source,
        });
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
mod tests;
