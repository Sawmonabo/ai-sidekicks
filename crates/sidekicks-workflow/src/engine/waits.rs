//! What the engine does with a step waiting on a person: it opens the wait under a fresh `waitId`
//! with its deadline, asks the person through an approval card or a question, makes the person's
//! answer the step's settlement; the engine's deadline clock fails a step whose deadline passed.
//!
//! The commit stores the wait, its id and deadline on the step's row, before anything asks the
//! person. A crash in between leaves a stored wait the restart asks again, never a question with no
//! stored wait to answer. The answer's intake, which makes an answer the step's resume and
//! settlement, is `answers`.

use std::collections::BTreeMap;
use std::error::Error;
use std::sync::Arc;
use std::time::Duration;

use rusqlite::Row;
use serde_json::{Map, Value, json};
use sidekicks_contracts::approval::ApprovalDecision;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::AnyValue;
use sidekicks_contracts::wire::id::{UuidTextForm, mint_uuid_v7};
use sidekicks_contracts::wire::instant::{NotAnInstant, WireInstant};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::definition::item::{
    WorkflowItem, WorkflowPairedItem, WorkflowPairedItems,
};
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::WorkflowWaitCause;
use sidekicks_contracts::workflow::run::step::events::WorkflowPhaseSuspendedPayload;
use sidekicks_contracts::workflow::run::step::record::{WorkflowPayloadRef, WorkflowStepKey};
use sidekicks_store::database::stored_column::{closed_word, safe_int_column, text_column};

use crate::engine::ports::{
    ApprovalCardRaiser, FormQuestionRequest, PersonWaitQuestions, PortError, ReplyQuestionRequest,
    StepAdmissionTicket, WorkflowApprovalCardRequest,
};
use crate::engine::tick::{RunScope, StepSettlement};
use crate::kinds::{PersonAsk, StepFailure, uncoded_step_error};

pub(crate) mod answers;

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
    let log_ref = log_ref.clone();
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
    /// write that stored the wait committed; the question store keeps the wait id, so no question
    /// id is answered. A failure fails the step uncoded, and the caller reports it.
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

#[cfg(test)]
mod tests;
