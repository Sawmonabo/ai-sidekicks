//! A job's processor budget and its meter. Each job registers a figure per unit of the work a run
//! reports, in units the job declares, and a run is measured on its own threads only, never the
//! whole process: each poll of its async work, each blocking closure and read from entry to exit,
//! and the time the writer's thread spends on the run's own statements. A run over its budget is
//! written to the program's log as a warning, one within it as a line of its own.
//!
//! The run's meter is the task-local of the run's task, so a read on the read pool, a write or a
//! maintenance request on the writer's thread and a blocking closure started through
//! [`run_blocking`] are measured into it with no meter passed down; a process the run starts is
//! not measured.

use std::error::Error;
use std::fmt::Debug;
use std::future::Future;
use std::io;
use std::mem;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_platforms::thread_cpu_time;
use tokio::task::JoinError;
use tokio_util::sync::CancellationToken;

use crate::mutex_lock::lock;
use crate::scheduler::ScheduledJobOutcome;

/// One term of a budget: `figure` of processor time per `per` units of `unit`, one of the units
/// the job declares.
#[derive(Clone, Copy, Debug)]
pub struct BudgetTerm<Unit> {
    /// The processor time allowed per `per` units.
    pub figure: Duration,
    /// The units the figure covers.
    pub per: u64,
    /// What the units count.
    pub unit: Unit,
}

/// A job's processor budget: a run may spend the sum of its terms over the work it reports.
#[derive(Clone, Copy, Debug)]
pub struct JobBudget<Unit: 'static> {
    terms: &'static [BudgetTerm<Unit>],
}

impl<Unit: Copy + Eq> JobBudget<Unit> {
    /// The budget summing `terms`; a term covering no units fails the build, since every budget is
    /// a constant.
    pub const fn new(terms: &'static [BudgetTerm<Unit>]) -> Self {
        let mut index = 0;
        while index < terms.len() {
            assert!(
                terms[index].per > 0,
                "a budget term covers at least one unit"
            );
            index += 1;
        }
        Self { terms }
    }

    /// The processor time a run that did `workload` may spend.
    pub(crate) fn allowance(self, workload: &JobWorkload<Unit>) -> Duration {
        let nanoseconds: u128 = self
            .terms
            .iter()
            .map(|term| {
                term.figure.as_nanos() * u128::from(workload.count(term.unit))
                    / u128::from(term.per)
            })
            .sum();
        Duration::from_nanos(u64::try_from(nanoseconds).unwrap_or(u64::MAX))
    }
}

/// What one run did, in its budget's units; a unit not reported counts none.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JobWorkload<Unit> {
    counts: Vec<(Unit, u64)>,
}

impl<Unit: Copy + Eq> JobWorkload<Unit> {
    /// The workload of `count` units of `unit`.
    pub fn of(unit: Unit, count: u64) -> Self {
        Self {
            counts: vec![(unit, count)],
        }
    }

    /// Adds `count` units of `unit`.
    pub fn add(&mut self, unit: Unit, count: u64) {
        self.counts.push((unit, count));
    }

    fn count(&self, unit: Unit) -> u64 {
        self.counts
            .iter()
            .filter(|(counted, _)| *counted == unit)
            .map(|(_, count)| *count)
            .fold(0, u64::saturating_add)
    }
}

// Processor time summed over readings of one thread's clock around pieces of a job's work, with
// the count of pieces measured; the first reading that failed is kept, so the run's line says its
// time could not be read.
#[derive(Debug, Default)]
struct ThreadProcessorTime {
    spent: SpentTime,
    unread: Option<io::Error>,
}

impl ThreadProcessorTime {
    // Runs `work` on the calling thread, adding the thread's processor time across it.
    fn measure<Answer>(&mut self, work: impl FnOnce() -> Answer) -> Answer {
        let start = thread_cpu_time();
        let answer = work();
        self.spent.readings += 1;
        match (start, thread_cpu_time()) {
            (Ok(start), Ok(end)) => self.spent.time += end.saturating_sub(start),
            (Err(failure), _) | (_, Err(failure)) => {
                self.unread.get_or_insert(failure);
            }
        }
        answer
    }
}

/// The processor time a run spent and the pieces of its work measured, each a pair of readings of
/// its thread's clock; a clock that moves in ticks errs by up to a tick per piece.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SpentTime {
    /// The processor time.
    pub time: Duration,
    /// The pieces measured.
    pub readings: u64,
}

tokio::task_local! {
    // The meter of the metered run whose task this is.
    static RUN_METER: ProcessorMeter;
}

/// The processor time one run spent on its own threads, which its parts add as they run.
#[derive(Clone, Debug, Default)]
pub struct ProcessorMeter {
    shared: Arc<Mutex<ThreadProcessorTime>>,
}

impl ProcessorMeter {
    /// The meter of the metered run whose task calls, `None` outside one. A task-local reaches no
    /// other task, so a caller reads it before handing work to a spawned task or the blocking pool.
    pub fn of_current_run() -> Option<Self> {
        RUN_METER.try_with(Self::clone).ok()
    }

    /// Runs `work` with this meter as its task's run meter, so its reads, writes and blocking work
    /// are measured on it as a metered job's are.
    pub async fn scope<Answer>(&self, work: impl Future<Output = Answer>) -> Answer {
        RUN_METER.scope(self.clone(), work).await
    }

    /// Runs `work` on the calling thread, measured on `meter` when there is one.
    pub fn measure_on<Answer>(meter: Option<&Self>, work: impl FnOnce() -> Answer) -> Answer {
        match meter {
            Some(meter) => meter.measure(work),
            None => work(),
        }
    }

    // Adds a thread's time to the run's.
    fn add(&self, time: ThreadProcessorTime) {
        let mut total = lock(&self.shared);
        total.spent.time += time.spent.time;
        total.spent.readings += time.spent.readings;
        if let Some(failure) = time.unread {
            total.unread.get_or_insert(failure);
        }
    }

    // Runs `work` on the calling thread, adding the thread's time across it.
    fn measure<Answer>(&self, work: impl FnOnce() -> Answer) -> Answer {
        let mut time = ThreadProcessorTime::default();
        let answer = time.measure(work);
        self.add(time);
        answer
    }

    /// Takes the run's time so far, leaving the meter at zero. Fails with the first reading that
    /// failed.
    pub fn take_spent(&self) -> Result<SpentTime, io::Error> {
        let total = mem::take(&mut *lock(&self.shared));
        match total.unread {
            Some(failure) => Err(failure),
            None => Ok(total.spent),
        }
    }
}

/// Runs `work` on the blocking pool, measured on the meter of the metered run whose task calls, if
/// any. Fails when the task ended before it finished.
pub async fn run_blocking<Answer: Send + 'static>(
    work: impl FnOnce() -> Answer + Send + 'static,
) -> Result<Answer, JoinError> {
    let meter = ProcessorMeter::of_current_run();
    tokio::task::spawn_blocking(move || ProcessorMeter::measure_on(meter.as_ref(), work)).await
}

/// What a metered run ends with: the work it did in its budget's units, `None` when it did none,
/// as a run its condition skipped.
pub type MeteredJobOutcome<Unit> = Result<Option<JobWorkload<Unit>>, Box<dyn Error + Send + Sync>>;

/// A run that failed after it did work: the work it did, which its processor time is still set
/// against, and the failure the scheduler reports.
#[derive(Debug, thiserror::Error)]
#[error("the job failed after its work")]
pub struct FailedAfterWork<Unit: Debug> {
    /// The work the run did before it failed.
    pub workload: JobWorkload<Unit>,
    /// The failure.
    #[source]
    pub failure: Box<dyn Error + Send + Sync>,
}

/// A job's work as a metered job takes it: given the scheduler's stop, it runs with the run's
/// meter as its task's task-local.
pub(crate) type MeteredRun<Unit> =
    Box<dyn FnMut(CancellationToken) -> BoxFuture<'static, MeteredJobOutcome<Unit>> + Send>;

/// The job the scheduler runs for `run` under `budget`: each run is metered on its own threads,
/// each poll of its future measured on the thread that polls it, its meter the task-local of the
/// run's task, and its time is written to the program's log beside its budget, as a warning when
/// it went over; a run over its budget is not stopped. A run that fails with [`FailedAfterWork`]
/// has its time written for that work too, and fails with the failure it carries.
pub fn metered_job<Unit: Copy + Eq + Debug + Send + Sync + 'static>(
    budget: JobBudget<Unit>,
    mut run: MeteredRun<Unit>,
) -> impl FnMut(CancellationToken) -> BoxFuture<'static, ScheduledJobOutcome> + Send + 'static {
    move |stop| {
        let meter = ProcessorMeter::default();
        let polled = MeteredPolls {
            future: RUN_METER.scope(meter.clone(), run(stop)).boxed(),
            meter: meter.clone(),
        };
        async move {
            match polled.await {
                Ok(Some(workload)) => log_processor_time(budget, &workload, meter.take_spent()),
                Ok(None) => {}
                Err(error) => {
                    return match error.downcast::<FailedAfterWork<Unit>>() {
                        Ok(failed) => {
                            log_processor_time(budget, &failed.workload, meter.take_spent());
                            Err(failed.failure)
                        }
                        Err(error) => Err(error),
                    };
                }
            }
            Ok(())
        }
        .boxed()
    }
}

// A run's future, each poll measured on the thread that runs it: one poll runs one task on one
// thread, so the difference is that task's processor time alone.
struct MeteredPolls<Unit> {
    future: BoxFuture<'static, MeteredJobOutcome<Unit>>,
    meter: ProcessorMeter,
}

impl<Unit> Future for MeteredPolls<Unit> {
    type Output = MeteredJobOutcome<Unit>;

    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        let mut time = ThreadProcessorTime::default();
        let polled = time.measure(|| self.future.poll_unpin(context));
        self.meter.add(time);
        polled
    }
}

// Writes a run's processor time beside its budget for `workload`.
fn log_processor_time<Unit: Copy + Eq + Debug>(
    budget: JobBudget<Unit>,
    workload: &JobWorkload<Unit>,
    spent: Result<SpentTime, io::Error>,
) {
    let allowed = budget.allowance(workload);
    match spent {
        Err(failure) => tracing::warn!(
            error = &failure as &(dyn Error + 'static),
            budget_ms = allowed.as_millis(),
            "the job's processor time could not be read"
        ),
        Ok(spent) if spent.time > allowed => tracing::warn!(
            spent_ms = spent.time.as_millis(),
            readings = spent.readings,
            budget_ms = allowed.as_millis(),
            ?workload,
            "the job took more processor time than its budget"
        ),
        Ok(spent) => tracing::info!(
            spent_ms = spent.time.as_millis(),
            readings = spent.readings,
            budget_ms = allowed.as_millis(),
            ?workload,
            "the job's processor time"
        ),
    }
}

#[cfg(test)]
mod tests {
    use std::hint::black_box;
    use std::time::Duration;

    use super::{BudgetTerm, JobBudget, JobWorkload, ProcessorMeter, RUN_METER, run_blocking};

    const MIB: u64 = 1024 * 1024;

    // Two units a test budget counts in.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum TestUnit {
        Bytes,
        LogBytes,
    }

    // A budget sums each term over the units the run reports, a unit not reported counting none.
    // Killed by a term read against the wrong unit and by a figure not scaled by its count.
    #[test]
    fn a_budget_sums_each_term_over_its_own_unit() {
        const TERMS: &[BudgetTerm<TestUnit>] = &[
            BudgetTerm {
                figure: Duration::from_secs(1),
                per: 256 * MIB,
                unit: TestUnit::Bytes,
            },
            BudgetTerm {
                figure: Duration::from_millis(250),
                per: 64 * MIB,
                unit: TestUnit::LogBytes,
            },
        ];
        let budget = JobBudget::new(TERMS);
        assert_eq!(
            budget.allowance(&JobWorkload::of(TestUnit::Bytes, 512 * MIB)),
            Duration::from_secs(2)
        );
        assert_eq!(
            budget.allowance(&JobWorkload::of(TestUnit::LogBytes, 32 * MIB)),
            Duration::from_millis(125)
        );
    }

    // Blocking work a metered run starts is charged to the run's task-local meter from its own
    // thread's clock: busy work counts, and a sleep of the same span counts almost nothing. Killed
    // by a wall-clock reading and by the meter read on the blocking thread, where no run is.
    #[tokio::test]
    async fn blocking_work_is_charged_from_its_own_threads_clock() {
        let meter = ProcessorMeter::default();
        RUN_METER
            .scope(meter.clone(), async {
                run_blocking(|| std::thread::sleep(Duration::from_millis(200)))
                    .await
                    .expect("the sleep ends");
                let slept = meter.take_spent().expect("the clock reads");
                assert_eq!(slept.readings, 1);
                assert!(slept.time < Duration::from_millis(50), "{slept:?}");
                run_blocking(|| {
                    let started = std::time::Instant::now();
                    let mut sum = 0_u64;
                    while started.elapsed() < Duration::from_millis(100) {
                        sum = black_box(sum.wrapping_add(1));
                    }
                })
                .await
                .expect("the busy work ends");
            })
            .await;
        assert!(meter.take_spent().expect("the clock reads").time >= Duration::from_millis(50));
    }
}
