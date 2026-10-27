//! A job's processor budget and its meter. Each job registers a figure per unit of the work a run
//! reports, and a run is measured on its own threads only, never the whole process: each poll of
//! its async work, each blocking closure and read from entry to exit, and the writer thread's time
//! around the job's own statements, which comes back in the thread's answer. A run over its budget
//! is written to the service log as a warning, one within it as a line of its own.

use std::error::Error;
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

/// What a job's work is counted in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WorkUnit {
    /// Bytes of the store a run copied or repacked.
    StoreBytes,
    /// Bytes of write-ahead log a checkpoint moved into the store.
    CheckpointedLogBytes,
    /// Entries an expiry examined.
    EntriesExamined,
    /// Files an expiry deleted.
    FilesDeleted,
    /// Artifacts the ingest reaper or the orphan sweep examined.
    ArtifactsExamined,
    /// Bytes of the crash dump a report was built from.
    DumpBytes,
    /// Rows a provider's own diagnostic store deleted for an expiry.
    RowsDeleted,
    /// Runs of the job, one each, for the fixed work every run does.
    Runs,
}

/// One term of a budget: `figure` of processor time per `per` units of `unit`.
#[derive(Clone, Copy, Debug)]
pub(crate) struct BudgetTerm {
    /// The processor time allowed per `per` units.
    pub(crate) figure: Duration,
    /// The units the figure covers.
    pub(crate) per: u64,
    /// What the units count.
    pub(crate) unit: WorkUnit,
}

/// A job's processor budget: a run may spend the sum of its terms over the work it reports.
#[derive(Clone, Copy, Debug)]
pub(crate) struct JobBudget {
    terms: &'static [BudgetTerm],
}

impl JobBudget {
    /// The budget summing `terms`; a term covering no units fails the build, since every budget is
    /// a constant.
    pub(crate) const fn new(terms: &'static [BudgetTerm]) -> Self {
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
    pub(crate) fn allowance(self, workload: &JobWorkload) -> Duration {
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
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct JobWorkload {
    counts: Vec<(WorkUnit, u64)>,
}

impl JobWorkload {
    /// The workload of `count` units of `unit`.
    pub(crate) fn of(unit: WorkUnit, count: u64) -> Self {
        Self {
            counts: vec![(unit, count)],
        }
    }

    /// Adds `count` units of `unit`.
    pub(crate) fn add(&mut self, unit: WorkUnit, count: u64) {
        self.counts.push((unit, count));
    }

    fn count(&self, unit: WorkUnit) -> u64 {
        self.counts
            .iter()
            .filter(|(counted, _)| *counted == unit)
            .map(|(_, count)| *count)
            .fold(0, u64::saturating_add)
    }
}

/// Processor time summed over readings of one thread's clock around pieces of a job's work, with
/// the count of pieces measured; the first reading that failed is kept, so the run's line says its
/// time could not be read.
#[derive(Debug, Default)]
pub(crate) struct ThreadProcessorTime {
    spent: SpentTime,
    unread: Option<io::Error>,
}

impl ThreadProcessorTime {
    /// Runs `work` on the calling thread, adding the thread's processor time across it.
    pub(crate) fn measure<Answer>(&mut self, work: impl FnOnce() -> Answer) -> Answer {
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
pub(crate) struct SpentTime {
    /// The processor time.
    pub(crate) time: Duration,
    /// The pieces measured.
    pub(crate) readings: u64,
}

/// What the writer's thread answers for the job's work it ran: the work's report, and its own
/// processor time around the job's statements.
#[derive(Debug)]
pub(crate) struct Measured<Report> {
    /// What the work reports.
    pub(crate) report: Report,
    /// The thread's processor time around the job's own statements.
    pub(crate) processor_time: ThreadProcessorTime,
}

/// The processor time one run spent on its own threads, which its parts add as they run.
#[derive(Clone, Debug, Default)]
pub(crate) struct ProcessorMeter {
    shared: Arc<Mutex<ThreadProcessorTime>>,
}

impl ProcessorMeter {
    /// Adds a thread's time to the run's.
    pub(crate) fn add(&self, time: ThreadProcessorTime) {
        let mut total = lock(&self.shared);
        total.spent.time += time.spent.time;
        total.spent.readings += time.spent.readings;
        if let Some(failure) = time.unread {
            total.unread.get_or_insert(failure);
        }
    }

    /// Runs `work` on the calling thread, adding the thread's time across it; for work that runs on
    /// a thread the run does not own, such as a read pool's.
    pub(crate) fn measure<Answer>(&self, work: impl FnOnce() -> Answer) -> Answer {
        let mut time = ThreadProcessorTime::default();
        let answer = time.measure(work);
        self.add(time);
        answer
    }

    /// Runs `work` on the blocking pool, adding its thread's time from entry to exit. Fails when
    /// the task ended before it finished.
    pub(crate) async fn run_blocking<Answer: Send + 'static>(
        &self,
        work: impl FnOnce() -> Answer + Send + 'static,
    ) -> Result<Answer, JoinError> {
        let meter = self.clone();
        tokio::task::spawn_blocking(move || meter.measure(work)).await
    }

    /// Takes the run's time so far, leaving the meter at zero. Fails with the first reading that
    /// failed.
    pub(crate) fn take_spent(&self) -> Result<SpentTime, io::Error> {
        let total = mem::take(&mut *lock(&self.shared));
        match total.unread {
            Some(failure) => Err(failure),
            None => Ok(total.spent),
        }
    }
}

/// What a metered run ends with: the work it did in its budget's units, `None` when it did none,
/// as a run its condition skipped.
pub(crate) type MeteredJobOutcome = Result<Option<JobWorkload>, Box<dyn Error + Send + Sync>>;

/// A job's work as a metered job takes it: given the scheduler's stop and the run's meter, which
/// its blocking work and the writer's answers add to.
pub(crate) type MeteredRun = Box<
    dyn FnMut(CancellationToken, ProcessorMeter) -> BoxFuture<'static, MeteredJobOutcome> + Send,
>;

/// The job the scheduler runs for `run` under `budget`: each run is metered on its own threads,
/// each poll of its future measured on the thread that polls it, and its time is written to the
/// service log beside its budget, as a warning when it went over; a run over its budget is not
/// stopped.
pub(crate) fn metered_job(
    budget: JobBudget,
    mut run: MeteredRun,
) -> impl FnMut(CancellationToken) -> BoxFuture<'static, ScheduledJobOutcome> + Send + 'static {
    move |stop| {
        let meter = ProcessorMeter::default();
        let polled = MeteredPolls {
            future: run(stop, meter.clone()),
            meter: meter.clone(),
        };
        async move {
            if let Some(workload) = polled.await? {
                log_processor_time(budget, &workload, meter.take_spent());
            }
            Ok(())
        }
        .boxed()
    }
}

// A run's future, each poll measured on the thread that runs it: one poll runs one task on one
// thread, so the difference is that task's processor time alone.
struct MeteredPolls {
    future: BoxFuture<'static, MeteredJobOutcome>,
    meter: ProcessorMeter,
}

impl Future for MeteredPolls {
    type Output = MeteredJobOutcome;

    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        let mut time = ThreadProcessorTime::default();
        let polled = time.measure(|| self.future.poll_unpin(context));
        self.meter.add(time);
        polled
    }
}

// Writes a run's processor time beside its budget for `workload`.
fn log_processor_time(
    budget: JobBudget,
    workload: &JobWorkload,
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

    use super::{BudgetTerm, JobBudget, JobWorkload, ProcessorMeter, WorkUnit};

    const MIB: u64 = 1024 * 1024;

    // A budget sums each term over the units the run reports, a unit not reported counting none.
    // Killed by a term read against the wrong unit and by a figure not scaled by its count.
    #[test]
    fn a_budget_sums_each_term_over_its_own_unit() {
        const TERMS: &[BudgetTerm] = &[
            BudgetTerm {
                figure: Duration::from_secs(1),
                per: 256 * MIB,
                unit: WorkUnit::StoreBytes,
            },
            BudgetTerm {
                figure: Duration::from_millis(250),
                per: 64 * MIB,
                unit: WorkUnit::CheckpointedLogBytes,
            },
        ];
        let budget = JobBudget::new(TERMS);
        assert_eq!(
            budget.allowance(&JobWorkload::of(WorkUnit::StoreBytes, 512 * MIB)),
            Duration::from_secs(2)
        );
        assert_eq!(
            budget.allowance(&JobWorkload::of(WorkUnit::CheckpointedLogBytes, 32 * MIB)),
            Duration::from_millis(125)
        );
    }

    // Blocking work is charged to the run from its own thread's clock: busy work counts, and a
    // sleep of the same span counts almost nothing. Killed by a wall-clock reading.
    #[tokio::test]
    async fn blocking_work_is_charged_from_its_own_threads_clock() {
        let meter = ProcessorMeter::default();
        meter
            .run_blocking(|| std::thread::sleep(Duration::from_millis(200)))
            .await
            .expect("the sleep ends");
        let slept = meter.take_spent().expect("the clock reads").time;
        assert!(slept < Duration::from_millis(50), "{slept:?}");
        meter
            .run_blocking(|| {
                let started = std::time::Instant::now();
                let mut sum = 0_u64;
                while started.elapsed() < Duration::from_millis(100) {
                    sum = black_box(sum.wrapping_add(1));
                }
            })
            .await
            .expect("the busy work ends");
        assert!(meter.take_spent().expect("the clock reads").time >= Duration::from_millis(50));
    }
}
