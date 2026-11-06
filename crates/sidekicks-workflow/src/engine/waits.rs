//! What the engine does with a step waiting on a person: it opens the wait under a fresh `waitId`
//! with its deadline, asks the person through an approval card or a question, makes the person's
//! answer the step's settlement, and fails a step whose deadline passed with
//! `workflow.step.timedOut`.
//!
//! The commit stores the wait, its id and deadline on the step's row, before anything asks the
//! person. A crash in between leaves a stored wait the restart asks again, never a question with no
//! stored wait to answer. The deadline on the row is the truth: one armed instant per engine holds
//! the earliest, read again from the rows at start, after each write that moves a deadline, and by
//! the scheduler across sleep. The answer's intake, which makes an answer the step's resume and
//! settlement, is `answers`.

use std::collections::{BTreeMap, HashSet};
use std::error::Error;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use jiff::Timestamp;
use rusqlite::{Connection, Row, named_params};
use serde_json::{Map, Value, json};
use sidekicks_contracts::approval::ApprovalDecision;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::AnyValue;
use sidekicks_contracts::wire::id::{UuidTextForm, mint_uuid_v7};
use sidekicks_contracts::wire::instant::{NotAnInstant, WireInstant};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::definition::item::{
    WorkflowItem, WorkflowPairedItem, WorkflowPairedItems,
};
use sidekicks_contracts::workflow::run::failures::{
    WorkflowStepTimedOutCause, WorkflowStepTimedOutDetails,
};
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::WorkflowWaitCause;
use sidekicks_contracts::workflow::run::step::events::WorkflowPhaseSuspendedPayload;
use sidekicks_contracts::workflow::run::step::record::{WorkflowPayloadRef, WorkflowStepKey};
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_std::scheduler::armed_instant::{ArmedInstant, InstantJob};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::stored_column::{closed_word, safe_int_column, text_column};
use tokio::sync::mpsc;

use crate::engine::ports::{
    ApprovalCardRaiser, FormQuestionRequest, PersonWaitQuestions, PortError, ReplyQuestionRequest,
    StepAdmissionTicket, WorkflowApprovalCardRequest,
};
use crate::engine::tick::{RunScope, StepReport, StepReportKind, StepSettlement};
use crate::kinds::{PersonAsk, StepFailure, coded_step_error, uncoded_step_error};

pub(crate) mod answers;

/// The statements the deadline clock runs on a read connection: the earliest deadline and the
/// steps due by an instant.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) const PERSON_WAIT_STATEMENT_CAPACITY: usize = 2;

/// The deadline clock's job, as the program's log names it.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
const DEADLINE_JOB: &str = "workflow person wait deadline";

/// The deadline clock's retry, as the program's log names it.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
const DEADLINE_RETRY_JOB: &str = "workflow person wait deadline retry";

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

/// A wait on a person the engine opened for a step: what the commit stores on the step's row and
/// writes in its `workflow.phase.suspended`.
#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct OpenedPersonWait {
    /// The wait's id, which the person's answer names.
    pub(crate) wait_id: UuidTextForm,
    /// What the step waits on: an approval, a form or a reply.
    pub(crate) cause: WorkflowWaitCause,
    /// When the step started waiting.
    pub(crate) started_at: WireInstant,
    /// When the wait gives up, where the node set a timeout.
    pub(crate) deadline_at: Option<WireInstant>,
}

/// Opens a wait for `ask` at `at`, under a fresh wait id, giving up `timeout` after `at` where one
/// is set. Fails the step, uncoded, when that deadline lies past the last instant a timestamp
/// holds.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) fn open_person_wait(
    ask: &PersonAsk,
    timeout: Option<Duration>,
    at: WireInstant,
) -> Result<OpenedPersonWait, StepFailure> {
    let deadline_at = match timeout {
        None => None,
        Some(timeout) => Some(deadline_after(&at, timeout).map_err(|error| {
            StepFailure::Failed(Box::new(uncoded_step_error(format!(
                "the step's wait deadline could not be set: {error}"
            ))))
        })?),
    };
    Ok(OpenedPersonWait {
        wait_id: UuidTextForm::from(mint_uuid_v7()),
        cause: ask_cause(ask),
        started_at: at,
        deadline_at,
    })
}

// `timeout` after `at`; fails when `at` does not read as a timestamp or the sum lies past the last.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn deadline_after(at: &WireInstant, timeout: Duration) -> Result<WireInstant, Box<dyn Error>> {
    let start = at.timestamp().ok_or(NotAnInstant)?;
    let deadline = start.checked_add(timeout)?;
    Ok(WireInstant::from_timestamp(deadline)
        .expect("a deadline after its start is after year 0000"))
}

// The wait cause `ask` opens.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn ask_cause(ask: &PersonAsk) -> WorkflowWaitCause {
    match ask {
        PersonAsk::Approval { .. } => WorkflowWaitCause::Approval,
        PersonAsk::Form { .. } => WorkflowWaitCause::Form,
        PersonAsk::Reply { .. } => WorkflowWaitCause::Reply,
    }
}

/// The `workflow.phase.suspended` of `step` in the session `session_id`, waiting on `ask` as
/// `opened` opened it: the arm `ask` names, carrying the wait's id, its deadline and `log_ref`, the
/// log the step wrote before it waited.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) fn suspended_payload(
    session_id: SessionId,
    step: &WorkflowStepKey,
    opened: &OpenedPersonWait,
    ask: &PersonAsk,
    log_ref: &WorkflowPayloadRef,
) -> WorkflowPhaseSuspendedPayload {
    let workflow_run_id = step.workflow_run_id;
    let node_id = step.node_id.clone();
    let attempt = step.attempt;
    let execution_index = step.execution_index;
    let wait_deadline_at = opened.deadline_at.clone();
    let wait_id = opened.wait_id;
    let log_ref = Some(log_ref.clone());
    match ask {
        PersonAsk::Approval { .. } => WorkflowPhaseSuspendedPayload::Approval {
            session_id,
            workflow_run_id,
            node_id,
            attempt,
            execution_index,
            provider_account_id: None,
            resume_at: None,
            wait_deadline_at,
            wait_id,
            log_ref,
        },
        PersonAsk::Form { .. } => WorkflowPhaseSuspendedPayload::Form {
            session_id,
            workflow_run_id,
            node_id,
            attempt,
            execution_index,
            provider_account_id: None,
            resume_at: None,
            wait_deadline_at,
            wait_id,
            log_ref,
        },
        PersonAsk::Reply { .. } => WorkflowPhaseSuspendedPayload::Reply {
            session_id,
            workflow_run_id,
            node_id,
            attempt,
            execution_index,
            provider_account_id: None,
            resume_at: None,
            wait_deadline_at,
            wait_id,
            log_ref,
        },
    }
}

/// The ports a step waiting on a person asks through, held apart from the dispatch's: the
/// approval cards and the session's questions.
#[derive(Clone)]
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct PersonWaitPorts {
    /// Raises an approval wait's card.
    pub(crate) cards: Arc<dyn ApprovalCardRaiser>,
    /// Opens a form or reply wait's question.
    pub(crate) questions: Arc<dyn PersonWaitQuestions>,
}

impl PersonWaitPorts {
    /// Asks the person what `ask` asks for `step` in `scope`'s run, under `opened`'s wait id, after
    /// parking `admission`, the step's place at the memory gate, where it has one. Called once the
    /// write that stored the wait committed; the question store keeps the wait id, so no question id
    /// is answered. A failure fails the step uncoded, and the caller reports it.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) async fn ask_person(
        &self,
        scope: &RunScope,
        step: &WorkflowStepKey,
        opened: &OpenedPersonWait,
        ask: &PersonAsk,
        admission: Option<&Arc<dyn StepAdmissionTicket>>,
    ) -> Result<(), PortError> {
        if let Some(ticket) = admission {
            ticket.park()?;
        }
        match ask {
            PersonAsk::Approval { prompt } => {
                self.cards
                    .raise(WorkflowApprovalCardRequest {
                        session_id: scope.session_id,
                        run_id: scope.run_id,
                        step: Some(step.clone()),
                        wait_id: opened.wait_id,
                        prompt: prompt.clone(),
                    })
                    .await
            }
            PersonAsk::Form {
                prompt,
                input_schema,
            } => self
                .questions
                .open_form(FormQuestionRequest {
                    session_id: scope.session_id,
                    step: step.clone(),
                    wait_id: opened.wait_id,
                    prompt: prompt.clone(),
                    input_schema: input_schema.clone(),
                })
                .await
                .map(|_question| ()),
            PersonAsk::Reply { prompt } => self
                .questions
                .open_reply(ReplyQuestionRequest {
                    session_id: scope.session_id,
                    step: step.clone(),
                    wait_id: opened.wait_id,
                    prompt: prompt.clone(),
                })
                .await
                .map(|_question| ()),
        }
    }
}

/// A person's answer to a step waiting on them: an approval card's decision, a form's fields keyed
/// by each field's id, or a chat reply's text.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) enum PersonWaitAnswer {
    /// The approval card's decision.
    Approval(ApprovalDecision),
    /// The submitted fields, keyed by each field's id.
    Form(Map<String, Value>),
    /// The reply's text.
    Reply(NonEmptyText),
}

impl PersonWaitAnswer {
    // The wait cause this answer settles.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    fn cause(&self) -> WorkflowWaitCause {
        match self {
            Self::Approval(_) => WorkflowWaitCause::Approval,
            Self::Form(_) => WorkflowWaitCause::Form,
            Self::Reply(_) => WorkflowWaitCause::Reply,
        }
    }
}

/// A step a person wait holds, as the tick's live record keeps it.
#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct WaitingPersonStep {
    /// The step.
    pub(crate) step: WorkflowStepKey,
    /// The wait's id.
    pub(crate) wait_id: UuidTextForm,
    /// What the step waits on.
    pub(crate) cause: WorkflowWaitCause,
    /// When the wait gives up, where it has a deadline.
    pub(crate) deadline_at: Option<WireInstant>,
}

/// Why an answer did not settle a wait; it answers `workflow.step.notWaiting`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) enum PersonWaitRefusal {
    /// The answer names another wait, is the wrong kind for the wait, or came at or after its
    /// deadline.
    #[error("the step is not waiting on this answer")]
    NotWaiting,
}

/// Makes `answer`, given at `at`, the settlement of `waiting`, the live step under the wait the
/// answer names, whose input is `input`. An approval puts the input on `approved` or on
/// `rejected`, each item paired to its index; a form gives one item of its fields and a reply one
/// item `{"reply": <text>}`, each paired to input item 0 where there is one. Refused `NotWaiting`
/// when the answer is not of the wait's kind, or `at` is at or after the deadline, even before the
/// deadline clock fires.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) fn settle_person_wait(
    waiting: &WaitingPersonStep,
    answer: PersonWaitAnswer,
    at: &WireInstant,
    input: Vec<WorkflowItem>,
) -> Result<StepSettlement, PersonWaitRefusal> {
    // An instant that does not read as a timestamp compares as the earliest.
    let is_past_deadline = waiting
        .deadline_at
        .as_ref()
        .is_some_and(|deadline| deadline.timestamp() <= at.timestamp());
    if answer.cause() != waiting.cause || is_past_deadline {
        return Err(PersonWaitRefusal::NotWaiting);
    }
    let first_input = (!input.is_empty()).then_some(WorkflowPairedItems::One(WorkflowPairedItem {
        item: SafeInt::ZERO,
        input: None,
    }));
    let outputs = match answer {
        PersonWaitAnswer::Approval(ApprovalDecision::Approved) => {
            vec![paired_to_their_index(input), Vec::new()]
        }
        PersonWaitAnswer::Approval(ApprovalDecision::Rejected) => {
            vec![Vec::new(), paired_to_their_index(input)]
        }
        PersonWaitAnswer::Form(fields) => {
            vec![vec![answer_item(Value::Object(fields), first_input)]]
        }
        PersonWaitAnswer::Reply(text) => {
            vec![vec![answer_item(
                json!({ "reply": text.into_string() }),
                first_input,
            )]]
        }
    };
    Ok(StepSettlement::Completed {
        outputs,
        cost: None,
        log_lines: Vec::new(),
        run_variables: BTreeMap::new(),
    })
}

// `items`, each paired to its own index in them.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn paired_to_their_index(items: Vec<WorkflowItem>) -> Vec<WorkflowItem> {
    items
        .into_iter()
        .enumerate()
        .map(|(position, mut item)| {
            item.paired_item = Some(WorkflowPairedItems::One(WorkflowPairedItem {
                item: SafeInt::from_usize(position),
                input: None,
            }));
            item
        })
        .collect()
}

// An item holding `json` and no binary value, its lineage `paired_item`.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn answer_item(json: Value, paired_item: Option<WorkflowPairedItems>) -> WorkflowItem {
    WorkflowItem {
        json: AnyValue(json),
        binary: None,
        paired_item,
        error: None,
    }
}

/// The step key in the first four columns of `row`: the run, the node, the attempt and the
/// execution index. Fails when a column does not read as its type.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) fn step_key(row: &Row<'_>) -> rusqlite::Result<WorkflowStepKey> {
    Ok(WorkflowStepKey {
        workflow_run_id: text_column(row, 0, |text| WorkflowRunId::new(&text))?,
        node_id: text_column(row, 1, closed_word)?,
        attempt: safe_int_column(row, 2)?,
        execution_index: safe_int_column(row, 3)?,
    })
}

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
) -> Result<Option<SystemTime>, PersonWaitDeadlineError> {
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
) -> Result<Vec<DueWait>, PersonWaitDeadlineError> {
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
pub(crate) enum PersonWaitDeadlineError {
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
pub(crate) struct PersonWaitDeadlines {
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

impl PersonWaitDeadlines {
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

impl InstantJob for PersonWaitDeadlines {
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
                    return Err(PersonWaitDeadlineError::ReportsClosed.into());
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
