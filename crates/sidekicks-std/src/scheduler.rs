//! The program's one scheduler: its timers run on the scheduler's own task and its jobs on a job
//! task, one job at a time in the order they fall due, so no timer waits for a job.
//!
//! - A timer only moves state in memory, wakes a task or hands its work to a task of its own, so it
//!   returns at once; the scheduler's task awaits it in place. A job (`Scheduler::schedule_job`) is
//!   the slow work: a backup, a repack, a cleanup pass. Each job run is spawned on a task of its
//!   own, and a job that falls due while another runs waits in a queue behind it, so two jobs never
//!   run at once and nothing is armed for the waiting one.
//! - A run set a delay away runs at a deadline on tokio's monotonic clock, the one its timer sleeps
//!   on, so setting the wall clock back or forward neither holds it back nor runs it early.
//! - A run set for an instant on the wall clock runs at that instant through the wall clock's own
//!   timer, the operating system's, which fires at it across sleep and across any change to the
//!   clock; the timer is armed for the first such instant as it is scheduled, and when it fires
//!   every such run whose instant that clock has reached goes, and the timer is armed for the next.
//! - The wake signal is the operating system's own resume event, which every receiver hears once.
//! - While no run is pending nothing is armed and no clock is read; otherwise only the first
//!   deadline and the first instant are.
//! - A run may go only while the busy count its caller hands the start is zero; one that falls due
//!   while the count is above zero is parked aside, so it never holds the task, and goes once the
//!   count reaches zero, or at the latest at its condition's instant on the wall clock, which the
//!   wall clock's timer fires at as it does a run's own instant. The count is read again before
//!   each run is taken, a queued job's when the job before it ends, so a count that rises while
//!   earlier runs go parks the runs after them.
//! - A job with a processor budget registers it with its run (`budget::metered_job`), which
//!   meters the run on its own threads and writes its processor time beside the budget.
//! - A timer its owner keeps armed for the next of its instants, armed again in place and retried a
//!   minute later when refused, is an `armed_instant::ArmedInstant`, which hands its owner's work
//!   to a task of its own.

use std::collections::{BTreeMap, VecDeque};
use std::error::Error;
use std::future::Future;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, SystemTime};

use futures::future::BoxFuture;
use sidekicks_platforms::{WakeWatch, WakeWatchError, WallClock};
use tokio::sync::{Notify, broadcast, oneshot, watch};
use tokio::task::{JoinError, JoinHandle};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tokio_util::task::AbortOnDropHandle;
use tracing::Instrument as _;

use crate::mutex_lock::lock;
pub use crate::scheduler::condition::JobCondition;
use crate::scheduler::condition::ParkedRuns;
use crate::scheduler::owner_tasks::OwnerTasks;

pub mod armed_instant;
pub mod budget;
mod condition;
mod owner_tasks;
#[cfg(any(test, feature = "test-support"))]
pub mod test_wall_clock;

// Wakes a receiver may fall behind before it reads a lag; wakes are rare.
const WAKE_SIGNAL_CAPACITY: usize = 16;

/// What one run of a job ends with; a failure is written to the program's log.
pub type ScheduledJobOutcome = Result<(), Box<dyn Error + Send + Sync>>;

// A timer's or a job's work, given the token the scheduler's stop cancels, which a job checks
// between its steps so the stop never waits on it for long.
type ScheduledJobRun =
    Box<dyn FnMut(CancellationToken) -> BoxFuture<'static, ScheduledJobOutcome> + Send>;

/// One wake of the machine from sleep, as the operating system announced it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WakeSignal;

/// Why a job could not be scheduled.
#[derive(Debug, thiserror::Error)]
pub enum ScheduleError {
    /// The scheduler has stopped.
    #[error("the scheduler has stopped, so the job \"{job}\" cannot be scheduled")]
    Stopped {
        /// The job's name, as the program's log names it.
        job: &'static str,
    },
    /// The operating system refused to arm the wall-clock timer for the job's instant.
    #[error("the wall-clock timer could not be armed for the job \"{job}\"")]
    TimerNotArmed {
        /// The job's name, as the program's log names it.
        job: &'static str,
        /// The system's refusal.
        #[source]
        source: io::Error,
    },
}

/// Why the scheduler's stop did not end its tasks cleanly.
#[derive(Debug, thiserror::Error)]
pub enum SchedulerStopError {
    /// The scheduler's task or an owner task ended abnormally: a timer, a job or the work a timer
    /// handed its owner panicked.
    #[error("a scheduler task ended abnormally")]
    Panicked(#[source] JoinError),
    /// A timer, the running job or an owner task still ran at the stop's deadline, so it was
    /// aborted.
    #[error("a scheduler task still ran at the stop's deadline and was aborted")]
    Overran,
}

/// When a job runs: once after a delay, once at a wall-clock instant, or repeatedly.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobCadence {
    /// One run this long from now on the monotonic clock; zero runs it at once.
    Delay(Duration),
    /// One run at this instant on the wall clock, which it reaches across sleep and clock
    /// changes; an instant already past runs it at once.
    WallClockInstant(SystemTime),
    /// A run `first_delay` from now, then again `interval` after each run ends.
    Repeating {
        /// The wait before the first run.
        first_delay: Duration,
        /// The wait after each run ends before the next.
        interval: Duration,
    },
}

/// What a caller holds for a scheduled job.
pub struct ScheduledJobHandle {
    scheduler: Weak<SchedulerShared>,
    job_id: u64,
    is_canceled: Arc<AtomicBool>,
    // For a wall-clock job, the refusal the task sends when it cannot arm the timer for its
    // instant.
    refusal: Option<oneshot::Receiver<ScheduleError>>,
}

/// The program's one scheduler and its wake signal: timers run on its task as they fall due, jobs
/// on a job task one at a time in the order they fall due, and a run scheduled after
/// `Scheduler::stop` is refused.
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
    // The tasks timers hand their owners' work to, which the stop waits for.
    owner_tasks: Mutex<OwnerTasks>,
}

struct SchedulerState {
    // Ordered by deadline, then by scheduling order, so the first entry is always the next due.
    pending_by_deadline: BTreeMap<(Instant, u64), PendingRun>,
    // Ordered by wall-clock instant, then by scheduling order.
    pending_by_instant: BTreeMap<(SystemTime, u64), PendingRun>,
    next_sequence: u64,
    next_job_id: u64,
    // The due runs whose condition failed, waiting for the busy count to reach zero or for their
    // bound.
    parked: ParkedRuns,
    // The jobs taken while another job ran, in the order taken, each waiting for the job before it
    // to end; nothing is armed for them.
    waiting_jobs: VecDeque<PendingRun>,
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

// Where a run goes: awaited on the scheduler's task, or spawned on the job task.
#[derive(Clone, Copy, PartialEq, Eq)]
enum RunKind {
    Timer,
    Job,
}

impl RunKind {
    // The kind as the program's log names it.
    fn as_str(self) -> &'static str {
        match self {
            Self::Timer => "timer",
            Self::Job => "job",
        }
    }
}

struct PendingRun {
    job_id: u64,
    name: &'static str,
    kind: RunKind,
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

// The one job running on the job task, with the run it came from, which arms again at its end.
// Dropping it aborts the job.
struct RunningJob {
    run: PendingRun,
    handle: AbortOnDropHandle<ScheduledJobOutcome>,
}

// What ended one of the task's waits, other than the stop and a change to the pending runs.
enum SchedulerEvent {
    DeadlineReached,
    WallClockTimerFired(io::Result<()>),
    MachineWoke(Result<(), WakeWatchError>),
    BusyChanged(Result<(), watch::error::RecvError>),
    JobEnded(Result<ScheduledJobOutcome, JoinError>),
}

impl Scheduler {
    /// Starts the scheduler's task on the running tokio runtime, which runs the timers and spawns
    /// each job run on a task of its own, running a wall-clock run on `wall_clock`'s timer,
    /// telling each wake `wake_watch` hears, and reading each run's condition against `busy`, a
    /// count of work the runs that wait for idle give way to; with no watch, receivers hear no
    /// wake.
    pub fn start(
        wall_clock: Arc<dyn WallClock>,
        wake_watch: Option<WakeWatch>,
        busy: watch::Receiver<u32>,
    ) -> Self {
        let state = SchedulerState {
            pending_by_deadline: BTreeMap::new(),
            pending_by_instant: BTreeMap::new(),
            parked: ParkedRuns::default(),
            waiting_jobs: VecDeque::new(),
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
            owner_tasks: Mutex::default(),
        });
        let task = tokio::spawn(Arc::clone(&shared).run(wake_watch, busy));
        Self {
            shared,
            task: Mutex::new(Some(task)),
        }
    }

    /// The names of the runs waiting to fall due, parked, or queued behind a running job, for a
    /// test to read what was scheduled.
    #[cfg(any(test, feature = "test-support"))]
    pub fn waiting_job_names(&self) -> Vec<&'static str> {
        let state = self.shared.lock_state();
        state
            .pending_by_deadline
            .values()
            .chain(state.pending_by_instant.values())
            .chain(&state.waiting_jobs)
            .map(|run| run.name)
            .chain(state.parked.names())
            .collect()
    }

    /// Schedules a job, `run`, named `name` in the program's log, at `cadence`, to run once
    /// `condition` allows. Each run goes on a task of its own, after the job running before it
    /// ends, so no timer waits for it. Refused once the scheduler has stopped, or, for a wall-clock
    /// instant, when the operating system refuses to arm the timer for it.
    pub fn schedule_job<Run>(
        &self,
        name: &'static str,
        condition: JobCondition,
        cadence: JobCadence,
        run: Run,
    ) -> Result<ScheduledJobHandle, ScheduleError>
    where
        Run: FnMut(CancellationToken) -> BoxFuture<'static, ScheduledJobOutcome> + Send + 'static,
    {
        let (due, repeat_interval) = match cadence {
            JobCadence::Delay(delay) => (RunDue::Deadline(Instant::now() + delay), None),
            JobCadence::WallClockInstant(instant) => (RunDue::WallClockInstant(instant), None),
            JobCadence::Repeating {
                first_delay,
                interval,
            } => (
                RunDue::Deadline(Instant::now() + first_delay),
                Some(interval),
            ),
        };
        self.add(
            name,
            RunKind::Job,
            condition,
            due,
            repeat_interval,
            Box::new(run),
        )
    }

    /// Schedules a timer, one run of `run`, named `name` in the program's log, `delay` from now on
    /// the monotonic clock, to run once `condition` allows; a zero delay runs it at once. A timer
    /// runs on the scheduler's task and returns at once, handing slow work to a task of its own.
    /// Refused once the scheduler has stopped.
    pub fn schedule<Run>(
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
            RunKind::Timer,
            condition,
            RunDue::Deadline(Instant::now() + delay),
            None,
            Box::new(run),
        )
    }

    /// Schedules a timer, one run of `run` at `instant` on the wall clock, which it reaches across
    /// sleep and clock changes, to run once `condition` allows; an instant already past runs it at
    /// once. A timer runs on the scheduler's task and returns at once, handing slow work to a task
    /// of its own. Refused once the scheduler has stopped, or when the operating system refuses to
    /// arm the timer for it.
    pub fn schedule_at<Run>(
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
            RunKind::Timer,
            condition,
            RunDue::WallClockInstant(instant),
            None,
            Box::new(run),
        )
    }

    /// Schedules a repeating timer, `run`, `first_delay` from now, then again `interval` after
    /// each run ends, so two runs of it never overlap, each running once `condition` allows. A
    /// timer runs on the scheduler's task and returns at once, handing slow work to a task of its
    /// own. Refused once the scheduler has stopped.
    pub fn schedule_repeating<Run>(
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
            RunKind::Timer,
            condition,
            RunDue::Deadline(Instant::now() + first_delay),
            Some(interval),
            Box::new(run),
        )
    }

    /// A receiver of every wake from now on; dropping it detaches. Once the scheduler has stopped,
    /// or wakes are no longer heard, the receiver is closed, since no wake comes again.
    pub fn on_wake(&self) -> broadcast::Receiver<WakeSignal> {
        self.shared
            .lock_state()
            .wake_sender
            .as_ref()
            .map_or_else(|| broadcast::channel(1).1, broadcast::Sender::subscribe)
    }

    /// Runs `work`, the work a timer hands its owner, on a task of its own that the stop waits for
    /// as it waits for a job.
    pub(crate) fn spawn_owner_task(&self, work: impl Future<Output = ()> + Send + 'static) {
        lock(&self.shared.owner_tasks).spawn(work);
    }

    /// Runs nothing more: drops every pending, parked and queued run, closes the wake receivers,
    /// cancels the token the running timer and the running job were given, then waits up to
    /// `deadline` for both and for the tasks timers handed their owners' work to. Fails when any
    /// of them panicked, or when one still ran at `deadline`, which aborts it; only the work they
    /// had handed to `spawn_blocking` runs on past the abort.
    pub async fn stop(&self, deadline: Instant) -> Result<(), SchedulerStopError> {
        let (pending_by_deadline, pending_by_instant, parked, waiting_jobs, wake_sender) = {
            let mut state = self.shared.lock_state();
            state.is_stopped = true;
            (
                std::mem::take(&mut state.pending_by_deadline),
                std::mem::take(&mut state.pending_by_instant),
                state.parked.take_all(),
                std::mem::take(&mut state.waiting_jobs),
                state.wake_sender.take(),
            )
        };
        self.shared.stop.cancel();
        // Dropped outside the lock, since a run's work may hold anything.
        drop(pending_by_deadline);
        drop(pending_by_instant);
        drop(parked);
        drop(waiting_jobs);
        drop(wake_sender);
        let task = lock(&self.task).take();
        let task_ended = match task {
            None => Ok(()),
            Some(mut task) => match tokio::time::timeout_at(deadline, &mut task).await {
                Ok(Ok(())) => Ok(()),
                Ok(Err(error)) => Err(SchedulerStopError::Panicked(error)),
                Err(_elapsed) => {
                    task.abort();
                    Err(SchedulerStopError::Overran)
                }
            },
        };
        // Closed under its lock, so a hand-over an aborted task was still making starts no task
        // the stop would not wait for.
        let owner_tasks = lock(&self.shared.owner_tasks).close();
        let owner_tasks_ended = owner_tasks.stop(deadline).await;
        task_ended.and(owner_tasks_ended)
    }

    fn add(
        &self,
        name: &'static str,
        kind: RunKind,
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
                kind,
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
    /// the scheduler stopped. The wait owns what it needs, so it may outlive the handle's borrow
    /// while the handle stays with its owner to cancel. A job set a delay away, or a second call,
    /// settles at once with `None`.
    pub fn refusal(&mut self) -> impl Future<Output = Option<ScheduleError>> + Send + 'static {
        let refusal = self.refusal.take();
        async move { refusal?.await.ok() }
    }

    /// Removes the job's future runs, a run queued behind a running job included; a run already
    /// going finishes. A repeat does nothing.
    pub fn cancel(&self) {
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
        // A queued run has nothing armed for it, so its removal need not turn the task.
        state
            .waiting_jobs
            .retain(|waiting| waiting.job_id != self.job_id);
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
        lock(&self.state)
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
    // the timer refuses keeps waiting for the busy count to reach zero.
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
                     waits for the busy count to reach zero"
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
    // machine's wakes, waits for the running job's end and, while a run is parked, follows the busy
    // count, until the stop, which waits for the running job to end. A count whose sender is gone
    // reads as zero, so nothing stays parked for it.
    async fn run(
        self: Arc<Self>,
        mut wake_watch: Option<WakeWatch>,
        mut busy: watch::Receiver<u32>,
    ) {
        let mut is_count_followed = true;
        // Held across every turn, so at most one job runs; dropped with the task, which aborts it.
        let mut running_job: Option<RunningJob> = None;
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
                () = self.stop.cancelled() => {
                    // The job holds the canceled token, so it ends soon; returning at once would
                    // abort it before it reads the token. The stop's deadline bounds the wait.
                    if let Some(mut job) = running_job.take() {
                        let ended = (&mut job.handle).await;
                        self.end_job(job, ended);
                    }
                    return;
                }
                () = self.head_changed.notified() => continue,
                ended = wait_for_job_end(running_job.as_mut()) => SchedulerEvent::JobEnded(ended),
                () = sleep_until_deadline(first_deadline) => SchedulerEvent::DeadlineReached,
                fired = self.wall_clock.wait() => SchedulerEvent::WallClockTimerFired(fired),
                woke = wait_for_wake(wake_watch.as_mut()) => SchedulerEvent::MachineWoke(woke),
                changed = busy.changed(), if is_parked && is_count_followed => {
                    SchedulerEvent::BusyChanged(changed)
                }
            };
            match event {
                SchedulerEvent::DeadlineReached | SchedulerEvent::BusyChanged(Ok(())) => {}
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
                SchedulerEvent::BusyChanged(Err(_closed)) => is_count_followed = false,
                SchedulerEvent::JobEnded(ended) => {
                    let job = running_job.take().expect("only a running job ends");
                    self.end_job(job, ended);
                }
            }
            let busy = is_count_followed.then_some(&busy);
            self.drain_due_runs(busy, &mut running_job).await;
        }
    }

    // Goes through every due run its condition allows, parking each it does not, and every parked
    // or queued run that may now go: a timer is awaited here, a job is spawned on the job task when
    // none runs and queued behind the running one otherwise. The busy count is read before each
    // take, zero when it is not followed.
    async fn drain_due_runs(
        &self,
        busy: Option<&watch::Receiver<u32>>,
        running_job: &mut Option<RunningJob>,
    ) {
        let busy_count = || busy.map_or(0, |busy| *busy.borrow());
        while let Some(mut due) = self.take_due_run(busy_count(), running_job.is_some()) {
            let span =
                tracing::info_span!("scheduled run", kind = due.kind.as_str(), job = due.name);
            let run = (due.run)(self.stop.clone()).instrument(span);
            match due.kind {
                RunKind::Timer => {
                    log_run_failure(due.kind, due.name, run.await);
                    self.arm_again(due);
                }
                RunKind::Job => {
                    *running_job = Some(RunningJob {
                        run: due,
                        handle: AbortOnDropHandle::new(tokio::spawn(run)),
                    });
                }
            }
        }
    }

    // Ends the job that ran: logs its failure and arms it again, so a repeating job's interval
    // counts from its end. A panic in the job is resumed here, ending the task as a panic in a
    // timer does.
    fn end_job(&self, job: RunningJob, ended: Result<ScheduledJobOutcome, JoinError>) {
        match ended {
            Ok(outcome) => log_run_failure(job.run.kind, job.run.name, outcome),
            Err(error) => std::panic::resume_unwind(
                error
                    .try_into_panic()
                    .expect("only the handle's drop aborts a job, so any other end is a panic"),
            ),
        }
        self.arm_again(job.run);
    }

    // Takes the first run that may go while the scheduler still runs. With no job running, the
    // first queued job its condition allows, or whose latest moment the wall clock has reached,
    // goes first, parking each queued job that may not. Then
    // a parked run released by the count or its latest moment, else the first due run its
    // condition allows, parking each due run it does not; while a job runs, each job these yield
    // is queued behind it, its condition read once it is taken again. The wall clock is read only
    // while a wall-clock run or a parked run's latest moment is pending.
    fn take_due_run(&self, busy: u32, is_job_running: bool) -> Option<PendingRun> {
        let mut state = self.lock_state();
        if state.is_stopped {
            return None;
        }
        if !is_job_running {
            while let Some(queued) = state.waiting_jobs.pop_front() {
                if queued.condition.allows(busy)
                    || queued
                        .condition
                        .latest()
                        .is_some_and(|latest| latest <= self.wall_clock.now())
                {
                    return Some(queued);
                }
                state.parked.park(queued);
            }
        }
        let now = Instant::now();
        while let Some(released) = state.parked.take_released(busy, || self.wall_clock.now()) {
            if is_job_running && released.kind == RunKind::Job {
                state.waiting_jobs.push_back(released);
                continue;
            }
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
            if is_job_running && due.kind == RunKind::Job {
                state.waiting_jobs.push_back(due);
                continue;
            }
            if due.condition.allows(busy) {
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

// Writes a run's failure to the program's log.
fn log_run_failure(kind: RunKind, name: &'static str, outcome: ScheduledJobOutcome) {
    if let Err(failure) = outcome {
        tracing::warn!(
            kind = kind.as_str(),
            job = name,
            error = &*failure as &(dyn Error + 'static),
            "a scheduled run failed"
        );
    }
}

// Waits for the running job's end, or forever when none runs.
async fn wait_for_job_end(
    running_job: Option<&mut RunningJob>,
) -> Result<ScheduledJobOutcome, JoinError> {
    match running_job {
        Some(job) => (&mut job.handle).await,
        None => std::future::pending().await,
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
