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
use jiff::{SignedDuration, Timestamp};
use rusqlite::{Connection, OptionalExtension as _, Row, named_params};
use sidekicks_contracts::daemon::config::RunTimeLimitMinutes;
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
use sidekicks_store::database::stored_column::{safe_int_column, text_column};
use tokio::sync::mpsc;

use crate::engine::ports::WorkflowRunLimits;
use crate::engine::tick::run_status::RunPersonWait;
use crate::engine::tick::step_failure::run_cap_failure;
use crate::engine::tick::{StepReport, StepReportKind, StepSettlement};
use crate::engine::waits::step_key;
use crate::kinds::{StepFailure, coded_step_error};

/// The statements the deadline clock runs on a read connection: the earliest person wait
/// deadline and resume, the steps due by an instant on each, the unfinished runs and a run's
/// lowest-index step.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) const ENGINE_DEADLINE_STATEMENT_CAPACITY: usize = 6;

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

// Reads the partial index on the resume in its order, as the deadline's read does.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
const EARLIEST_RESUME_SQL: &str = "SELECT workflow_run_id, resume_at FROM workflow_steps \
     WHERE resume_at IS NOT NULL ORDER BY resume_at";

// A resume is set only while a spent account holds the step, so no status test is needed.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
const DUE_RESUMES_SQL: &str = "SELECT workflow_run_id, node_id, attempt, execution_index \
     FROM workflow_steps WHERE resume_at IS NOT NULL AND resume_at <= @instant \
     ORDER BY resume_at, execution_index";

// A deadline is set only while a person wait holds the step, so no status test is needed.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
const DUE_WAITS_SQL: &str = "SELECT workflow_run_id, node_id, attempt, execution_index, \
     wait_started_at, wait_deadline_at FROM workflow_steps \
     WHERE wait_deadline_at IS NOT NULL AND wait_deadline_at <= @instant \
     ORDER BY wait_deadline_at, execution_index";

// The instant a run that started at `started_at` passes `limit` once the `person_wait_ms` it
// waited on people are added, `None` past the last instant a timestamp holds.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn cap_instant(
    started_at: Timestamp,
    limit: RunTimeLimitMinutes,
    person_wait_ms: u64,
) -> Option<Timestamp> {
    let span_ms = (u64::from(limit.get()) * 60_000).checked_add(person_wait_ms)?;
    started_at
        .checked_add(SignedDuration::from_millis(i64::try_from(span_ms).ok()?))
        .ok()
}

// Every run not finished, a failed park among them, through the partial index on its start; a
// run waiting on a person has no cap until the wait ends.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
const UNFINISHED_RUNS_SQL: &str = "SELECT id, started_at, person_wait_ms FROM workflow_runs \
     WHERE finished_at IS NULL AND person_wait_since IS NULL";

// A run's lowest-index step, which the run cap's failure is reported on.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
const LOWEST_STEP_SQL: &str = "SELECT workflow_run_id, node_id, attempt, execution_index \
     FROM workflow_steps WHERE workflow_run_id = ?1 ORDER BY execution_index LIMIT 1";

// The stored instant in column `index` of `row`, as a timestamp.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn stored_timestamp(row: &Row<'_>, index: usize) -> rusqlite::Result<Timestamp> {
    text_column(row, index, |text| {
        WireInstant::try_from(text)?.timestamp().ok_or(NotAnInstant)
    })
}

// The earliest instant `sql` reads, a run id then a stored instant in its order, of a run not in
// `skipped`, `None` when there is none.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn earliest_step_instant(
    connection: &Connection,
    sql: &str,
    skipped: &HashSet<WorkflowRunId>,
) -> Result<Option<SystemTime>, EngineDeadlineError> {
    let mut statement = connection.prepare_cached(sql)?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let run_id = text_column(row, 0, |text| WorkflowRunId::new(&text))?;
        if !skipped.contains(&run_id) {
            return Ok(Some(SystemTime::from(stored_timestamp(row, 1)?)));
        }
    }
    Ok(None)
}

// The cap of each unfinished run not in `skipped` and with no person wait open, under `limit`;
// a run whose cap lies past the last instant a timestamp holds has none.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn unfinished_run_caps(
    connection: &Connection,
    limit: RunTimeLimitMinutes,
    skipped: &HashSet<WorkflowRunId>,
) -> Result<Vec<(WorkflowRunId, Timestamp)>, EngineDeadlineError> {
    let mut statement = connection.prepare_cached(UNFINISHED_RUNS_SQL)?;
    let mut rows = statement.query([])?;
    let mut caps = Vec::new();
    while let Some(row) = rows.next()? {
        let run_id = text_column(row, 0, |text| WorkflowRunId::new(&text))?;
        if skipped.contains(&run_id) {
            continue;
        }
        let person_wait_ms: SafeInt<0> = safe_int_column(row, 2)?;
        if let Some(cap) = cap_instant(stored_timestamp(row, 1)?, limit, person_wait_ms.get()) {
            caps.push((run_id, cap));
        }
    }
    Ok(caps)
}

// The earliest deadline of a run not in `skipped`: a person wait's, a parked step's resume, or a
// run's cap under `limit` where one is set; `None` when there is none.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn earliest_deadline(
    connection: &Connection,
    skipped: &HashSet<WorkflowRunId>,
    limit: Option<RunTimeLimitMinutes>,
) -> Result<Option<SystemTime>, EngineDeadlineError> {
    let wait = earliest_step_instant(connection, EARLIEST_DEADLINE_SQL, skipped)?;
    let resume = earliest_step_instant(connection, EARLIEST_RESUME_SQL, skipped)?;
    let cap = match limit {
        Some(limit) => unfinished_run_caps(connection, limit, skipped)?
            .into_iter()
            .map(|(_, cap)| SystemTime::from(cap))
            .min(),
        None => None,
    };
    Ok(wait.into_iter().chain(resume).chain(cap).min())
}

// Every report due at `instant` of a run not in `skipped`: each person wait past its deadline
// fails timed out, earliest first, each parked step whose resume passed comes due, earliest
// first, then each run past its cap under `limit` fails on its lowest-index step with the cap's
// failure.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn due_reports(
    connection: &Connection,
    instant: &WireInstant,
    skipped: &HashSet<WorkflowRunId>,
    limit: Option<RunTimeLimitMinutes>,
) -> Result<Vec<(WorkflowStepKey, StepReportKind)>, EngineDeadlineError> {
    let failed = |failure| {
        StepReportKind::Settled(StepSettlement::Failed {
            failure,
            log_lines: Vec::new(),
        })
    };
    let mut due: Vec<(WorkflowStepKey, StepReportKind)> = due_person_waits(connection, instant)?
        .into_iter()
        .filter(|due_wait| !skipped.contains(&due_wait.step.workflow_run_id))
        .map(|DueWait { step, limit_ms }| {
            let failure = step_timed_out(&step, limit_ms);
            (step, failed(failure))
        })
        .collect();
    let resumes = connection
        .prepare_cached(DUE_RESUMES_SQL)?
        .query_map(named_params! { "@instant": instant.as_str() }, step_key)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    due.extend(
        resumes
            .into_iter()
            .filter(|step| !skipped.contains(&step.workflow_run_id))
            .map(|step| (step, StepReportKind::ResumeDue)),
    );
    let Some(limit) = limit else {
        return Ok(due);
    };
    let now = instant
        .timestamp()
        .expect("an instant made from a timestamp reads as one");
    let limit_ms = SafeInt::new(u64::from(limit.get()) * 60_000)
        .expect("a run time limit's milliseconds are a safe integer");
    let mut lowest_step = connection.prepare_cached(LOWEST_STEP_SQL)?;
    for (run_id, cap) in unfinished_run_caps(connection, limit, skipped)? {
        if cap > now {
            continue;
        }
        if let Some(step) = lowest_step
            .query_row([run_id.text().as_str()], step_key)
            .optional()?
        {
            due.push((step, failed(run_cap_failure(limit_ms))));
        }
    }
    Ok(due)
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
    #[error("a read of the engine's deadlines failed")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read's blocking task did not
    /// finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// The tick that takes step reports has stopped.
    #[error("the engine's step reports are closed")]
    ReportsClosed,
}

/// The engine's one deadline clock over every step waiting on a person or a spent account and
/// every unfinished run: armed at the earliest stored deadline, resume or run cap, it fails each
/// step whose deadline passed with `workflow.step.timedOut`, resumes each parked step whose resume
/// came due, and fails each run past its cap on its lowest-index step.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct EngineDeadlines {
    /// The clock's one job on the wall clock.
    armed: ArmedInstant,
    /// The connections the rows are read on.
    reads: Arc<DatabaseReadPool>,
    /// Where a due step's failure is reported, to the tick.
    reports: mpsc::Sender<StepReport>,
    /// `Stop a run after`, read again at each use, so a change holds from the next.
    limits: Arc<dyn WorkflowRunLimits>,
    /// The runs the tick dropped in this daemon life, whose stored waits stay off the clock until
    /// the restart settles them; one id per failed write, and the restart starts with none.
    skipped: Mutex<HashSet<WorkflowRunId>>,
}

impl EngineDeadlines {
    /// The clock on `scheduler`, reading on `reads`, reporting to `reports` and holding each run to
    /// the run time limit `limits` answers; nothing is armed until its first
    /// [`InstantJob::rearm`].
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn new(
        scheduler: Arc<Scheduler>,
        reads: Arc<DatabaseReadPool>,
        reports: mpsc::Sender<StepReport>,
        limits: Arc<dyn WorkflowRunLimits>,
    ) -> Arc<Self> {
        Arc::new(Self {
            armed: ArmedInstant::new(scheduler, DEADLINE_JOB, DEADLINE_RETRY_JOB),
            reads,
            reports,
            limits,
            skipped: Mutex::new(HashSet::new()),
        })
    }

    /// When the run that started at `run_started_at`, its person-wait columns `person_wait`,
    /// passes `Stop a run after` as set now: `None` with no limit, or while a person wait is open,
    /// since the cap does not count a wait on a person.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn cap_deadline(
        &self,
        run_started_at: Timestamp,
        person_wait: &RunPersonWait,
    ) -> Option<WireInstant> {
        if person_wait.since.is_some() {
            return None;
        }
        let cap = cap_instant(
            run_started_at,
            self.limits.run_time_limit()?,
            person_wait.total_ms,
        )?;
        WireInstant::from_timestamp(cap)
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

    /// Reports every step whose deadline is at or before `instant` failed, every parked step whose
    /// resume came due, and every run past its cap, once, but a dropped run's: it arms nothing again, so a deadline is not reported twice
    /// before the commit clears it, and the tick calls [`InstantJob::rearm`] after that write.
    fn fire(
        self: Arc<Self>,
        instant: SystemTime,
    ) -> BoxFuture<'static, Result<(), Box<dyn Error + Send + Sync>>> {
        async move {
            let instant = WireInstant::from_timestamp(Timestamp::try_from(instant)?)
                .expect("an instant armed from a stored deadline is after year 0000");
            let skipped = lock(&self.skipped).clone();
            let limit = self.limits.run_time_limit();
            let due = self
                .reads
                .read(ReadLength::Short, move |connection| {
                    due_reports(connection, &instant, &skipped, limit)
                })
                .await?;
            for (step, kind) in due {
                let report = StepReport {
                    step,
                    at: WireInstant::now(),
                    kind,
                };
                if self.reports.send(report).await.is_err() {
                    return Err(EngineDeadlineError::ReportsClosed.into());
                }
            }
            Ok(())
        }
        .boxed()
    }

    /// Reads the earliest stored deadline, resume or run cap of a run not dropped, under `Stop a
    /// run after` as set now, and arms the clock at it, or disarms it when there is none; a failed
    /// read is tried again a minute later while nothing is armed.
    fn rearm(self: Arc<Self>) -> BoxFuture<'static, ()> {
        async move {
            let skipped = lock(&self.skipped).clone();
            let limit = self.limits.run_time_limit();
            match self
                .reads
                .read(ReadLength::Short, move |connection| {
                    earliest_deadline(connection, &skipped, limit)
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
