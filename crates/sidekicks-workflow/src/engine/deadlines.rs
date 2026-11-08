//! The engine's one deadline clock. The deadline on a step's row is the truth: one armed instant
//! holds the earliest, read again from the rows at start, after each write that moves one, and by
//! the scheduler across sleep, so it fires even while no turn runs. A fire reports each step whose
//! deadline passed to the tick, which commits its failure.

use std::collections::HashSet;
use std::error::Error;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use jiff::Timestamp;
use rusqlite::{Connection, Row, named_params};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::wire::instant::{NotAnInstant, WireInstant};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::run::failures::{
    WorkflowStepTimedOutCause, WorkflowStepTimedOutDetails,
};
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_std::scheduler::armed_instant::{ArmedInstant, InstantJob};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::stored_column::text_column;
use tokio::sync::mpsc;

use crate::engine::tick::{StepReport, StepReportKind, StepSettlement};
use crate::engine::waits::step_key;
use crate::kinds::{StepFailure, coded_step_error};

/// The statements the deadline clock runs on a read connection: the earliest deadline and the
/// steps due by an instant.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) const ENGINE_DEADLINE_STATEMENT_CAPACITY: usize = 2;

/// The deadline clock's job, as the program's log names it.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
const DEADLINE_JOB: &str = "workflow engine deadline";

/// The deadline clock's retry, as the program's log names it.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
const DEADLINE_RETRY_JOB: &str = "workflow engine deadline retry";

// Reads the partial index on the deadline in its order, with no sort, so the read stops at the
// first row of a run not dropped.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
const EARLIEST_DEADLINE_SQL: &str = "SELECT workflow_run_id, wait_deadline_at FROM workflow_steps \
     WHERE wait_deadline_at IS NOT NULL ORDER BY wait_deadline_at";

// A deadline is set only while a person wait holds the step, so no status test is needed.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
const DUE_WAITS_SQL: &str = "SELECT workflow_run_id, node_id, attempt, execution_index, \
     wait_started_at, wait_deadline_at FROM workflow_steps \
     WHERE wait_deadline_at IS NOT NULL AND wait_deadline_at <= @instant \
     ORDER BY wait_deadline_at, execution_index";

// The stored instant in column `index` of `row`, as a timestamp.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn stored_timestamp(row: &Row<'_>, index: usize) -> rusqlite::Result<Timestamp> {
    text_column(row, index, |text| {
        WireInstant::try_from(text)?.timestamp().ok_or(NotAnInstant)
    })
}

// The earliest deadline of a step waiting on a person in a run not in `skipped`, `None` when no
// such wait has one.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn earliest_person_wait_deadline(
    connection: &Connection,
    skipped: &HashSet<WorkflowRunId>,
) -> Result<Option<SystemTime>, EngineDeadlineError> {
    let mut statement = connection.prepare_cached(EARLIEST_DEADLINE_SQL)?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let run_id = text_column(row, 0, |text| WorkflowRunId::new(&text))?;
        if !skipped.contains(&run_id) {
            return Ok(Some(SystemTime::from(stored_timestamp(row, 1)?)));
        }
    }
    Ok(None)
}

// A step whose deadline passed, and how long its wait was allowed.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
struct DueWait {
    step: WorkflowStepKey,
    limit_ms: SafeInt<1>,
}

// Every step waiting on a person whose deadline is at or before `instant`, earliest first.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn due_person_waits(
    connection: &Connection,
    instant: &WireInstant,
) -> Result<Vec<DueWait>, EngineDeadlineError> {
    let due = connection
        .prepare_cached(DUE_WAITS_SQL)?
        .query_map(named_params! { "@instant": instant.as_str() }, |row| {
            let started_at = stored_timestamp(row, 4)?;
            let deadline_at = stored_timestamp(row, 5)?;
            let limit_ms = (deadline_at.as_millisecond() - started_at.as_millisecond()).max(1);
            Ok(DueWait {
                step: step_key(row)?,
                limit_ms: u64::try_from(limit_ms)
                    .ok()
                    .and_then(SafeInt::new)
                    .expect("the span between two stored instants is under 2^53 milliseconds"),
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(due)
}

// The failure of `step`, whose wait passed its deadline `limit_ms` after it began.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn step_timed_out(step: &WorkflowStepKey, limit_ms: SafeInt<1>) -> StepFailure {
    let details = WorkflowStepTimedOutDetails {
        cause: WorkflowStepTimedOutCause::StepTimeout,
        limit_ms,
    };
    StepFailure::Failed(Box::new(coded_step_error(
        RefusalCode::WorkflowStepTimedOut,
        "The step's wait passed its timeout".to_owned(),
        serde_json::to_value(details).expect("the timed-out details write as JSON"),
        Some(step.node_id.clone()),
    )))
}

/// Why the deadline clock could not read the waits or report a due one.
#[derive(Debug, thiserror::Error)]
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) enum EngineDeadlineError {
    /// SQLite refused a read, or a stored value did not read as its type.
    #[error("a read of the steps waiting on a person failed")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read's blocking task did not
    /// finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// The tick that takes step reports has stopped.
    #[error("the engine's step reports are closed")]
    ReportsClosed,
}

/// The engine's one deadline clock over every step waiting on a person: armed at the earliest
/// stored deadline, it fails each step whose deadline passed with `workflow.step.timedOut`.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct EngineDeadlines {
    /// The clock's one job on the wall clock.
    armed: ArmedInstant,
    /// The connections the rows are read on.
    reads: Arc<DatabaseReadPool>,
    /// Where a due step's failure is reported, to the tick.
    reports: mpsc::Sender<StepReport>,
    /// The runs the tick dropped in this daemon life, whose stored waits stay off the clock until
    /// the restart settles them; one id per failed write, and the restart starts with none.
    skipped: Mutex<HashSet<WorkflowRunId>>,
}

impl EngineDeadlines {
    /// The clock on `scheduler`, reading on `reads` and reporting to `reports`; nothing is armed
    /// until its first [`InstantJob::rearm`].
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn new(
        scheduler: Arc<Scheduler>,
        reads: Arc<DatabaseReadPool>,
        reports: mpsc::Sender<StepReport>,
    ) -> Arc<Self> {
        Arc::new(Self {
            armed: ArmedInstant::new(scheduler, DEADLINE_JOB, DEADLINE_RETRY_JOB),
            reads,
            reports,
            skipped: Mutex::new(HashSet::new()),
        })
    }

    /// Keeps the waits of the dropped run `run_id` off the clock from its next read on.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn skip_run(&self, run_id: WorkflowRunId) {
        lock(&self.skipped).insert(run_id);
    }
}

impl InstantJob for EngineDeadlines {
    fn armed_instant(&self) -> &ArmedInstant {
        &self.armed
    }

    /// Reports every step whose deadline is at or before `instant` failed, once, but a dropped
    /// run's: it arms nothing again, so a deadline is not reported twice before the commit clears
    /// it, and the tick calls [`InstantJob::rearm`] after that write.
    fn fire(
        self: Arc<Self>,
        instant: SystemTime,
    ) -> BoxFuture<'static, Result<(), Box<dyn Error + Send + Sync>>> {
        async move {
            let instant = WireInstant::from_timestamp(Timestamp::try_from(instant)?)
                .expect("an instant armed from a stored deadline is after year 0000");
            let mut due = self
                .reads
                .read(ReadLength::Short, move |connection| {
                    due_person_waits(connection, &instant)
                })
                .await?;
            {
                let skipped = lock(&self.skipped);
                due.retain(|due_wait| !skipped.contains(&due_wait.step.workflow_run_id));
            }
            for DueWait { step, limit_ms } in due {
                let failure = step_timed_out(&step, limit_ms);
                let report = StepReport {
                    step,
                    at: WireInstant::now(),
                    kind: StepReportKind::Settled(StepSettlement::Failed {
                        failure,
                        log_lines: Vec::new(),
                    }),
                };
                if self.reports.send(report).await.is_err() {
                    return Err(EngineDeadlineError::ReportsClosed.into());
                }
            }
            Ok(())
        }
        .boxed()
    }

    /// Reads the earliest stored deadline of a run not dropped and arms the clock at it, or
    /// disarms it when no such wait has one; a failed read is tried again a minute later while
    /// nothing is armed.
    fn rearm(self: Arc<Self>) -> BoxFuture<'static, ()> {
        async move {
            let skipped = lock(&self.skipped).clone();
            match self
                .reads
                .read(ReadLength::Short, move |connection| {
                    earliest_person_wait_deadline(connection, &skipped)
                })
                .await
            {
                Ok(next) => ArmedInstant::arm(&self, next),
                Err(error) => ArmedInstant::retry_while_empty(&self, &error),
            }
        }
        .boxed()
    }
}

#[cfg(test)]
mod tests;
