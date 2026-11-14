//! A workflow gate's approval card: the card a workflow's approval step or chain question raises,
//! held by its workflow wait rather than an agent run. Its answer is handed with its write to the
//! workflow engine, which settles the card in the step's own write, so the card, the gate's record
//! and the step's resume land together.

use std::borrow::Cow;
use std::error::Error;
use std::sync::LazyLock;

use futures::future::{BoxFuture, join_all};
use sidekicks_contracts::approval::events::{ApprovalRequestedPayload, ApprovalResolvedPayload};
use sidekicks_contracts::approval::holder::ApprovalHolder;
use sidekicks_contracts::approval::{
    ApprovalCategory, ApprovalDecision, ApprovalLateCreateReason, ApprovalRequestId, ApprovalScope,
};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::free_form_string::FILE_PATH_MAX_LEN;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::{UuidTextForm, mint_uuid_v7};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::record::JsonRecord;
use sidekicks_contracts::wire::text::{FreeFormText, NonEmptyText};
use sidekicks_contracts::workflow::definition::document::WorkflowNodeId;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::events::session::appender::{
    SessionEventAppendError, SessionEventDraft, SessionEventLinkage,
};
use sidekicks_workflow::runs::record::{chain_question_waiting_condition, finished_run_condition};

use crate::events::resolved_event;
use crate::refusals::{approval_late_create, approval_request_canceled};
use crate::request_create::ApprovalResourceDescriptor;
use crate::service::{
    ApprovalService, ApprovalServiceError, ResolveAnswer, ResolvedAnswer, refusal_of_failed_write,
    resolved_answer_of,
};
use crate::store::{
    ApprovalSettlement, INSERT_REQUEST_SQL, InsertedApprovalRequest, InsertedApprovalResolution,
    StoredApprovalRequest, insert_resolution_statement, request_statement, session_open_statement,
    settle_pending_statement,
};

// A raise's write of a workflow wait's card, refused by changing no row where the wait's card is
// already open, which the open wait's unique index holds.
static INSERT_WAIT_REQUEST_SQL: LazyLock<String> =
    LazyLock::new(|| format!("{}\n  ON CONFLICT DO NOTHING", *INSERT_REQUEST_SQL));

// A guard's read of a step card's workflow run in the card's session, not yet finished: going,
// or parked on its failed step.
static STEP_CARD_RUN_GOING_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT 1 FROM workflow_runs AS run
  WHERE run.id = @workflow_run_id AND run.session_id = @session_id
    AND NOT {}",
        finished_run_condition("run")
    )
});

// A guard's read of a chain card's first run in the card's session, while the chain's question
// still waits; the first run itself has usually ended by then.
static CHAIN_CARD_QUESTION_WAITING_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT 1 FROM workflow_runs AS run
  WHERE run.id = @workflow_run_id AND run.session_id = @session_id
    AND {}",
        chain_question_waiting_condition("run.id")
    )
});

// The positions of a raise's guards and its insert among its statements.
const GATE_SESSION_OPEN_GUARD_INDEX: usize = 0;
const GATE_HOLDER_GUARD_INDEX: usize = 1;
const GATE_INSERT_INDEX: usize = 2;

// A guard that refuses its write once the card's holder no longer stands in `session_id`: a step
// card's run has finished or is gone, or a chain card's question no longer waits.
fn wait_holder_statement(
    session_id: &SessionId,
    workflow_run_id: &WorkflowRunId,
    node_id: Option<&WorkflowNodeId>,
) -> WriteStatement {
    let sql = match node_id {
        Some(_) => STEP_CARD_RUN_GOING_SQL.as_str(),
        None => CHAIN_CARD_QUESTION_WAITING_SQL.as_str(),
    };
    WriteStatement {
        sql: Cow::Borrowed(sql),
        bindings: StatementBindings::Named(vec![
            text_binding("@workflow_run_id", workflow_run_id.text().as_str()),
            text_binding("@session_id", session_id.text().as_str()),
        ]),
        expected_row_count: Some(1),
    }
}

/// How one write of a raise ended: its card raised, or its insert lost to another raise's card.
enum GateWrite {
    Raised(ApprovalRequestId),
    LostInsert(SessionEventAppendError),
}

// The statement that records a workflow wait's new pending card, refused by changing no row
// where the wait's card is already open.
fn insert_wait_request_statement(request: &InsertedApprovalRequest) -> WriteStatement {
    request_statement(&INSERT_WAIT_REQUEST_SQL, request)
}

/// The card a workflow wait raises: a step's approval, or a chain's question, which names no node.
/// The workflow's name is the card's chip and the subject it names; the prompt is shown whole.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkflowGateCardAsk {
    /// The session the card is raised in, the workflow run's.
    pub session_id: SessionId,
    /// The workflow run whose wait holds the card.
    pub workflow_run_id: WorkflowRunId,
    /// The wait; a second raise for it answers its open card.
    pub wait_id: UuidTextForm,
    /// The step's node; absent on a chain's question.
    pub node_id: Option<WorkflowNodeId>,
    /// The workflow's name, as the card's subject and the requester it names.
    pub workflow_name: FreeFormText<FILE_PATH_MAX_LEN>,
    /// What the card asks.
    pub prompt: NonEmptyText,
}

/// A person's answer to a workflow wait's card, with the write that records it: the engine runs
/// `statements` and appends `event` in the step's own write, which settles the card.
#[derive(Debug)]
pub struct ApprovalWaitAnswer {
    /// The session.
    pub session_id: SessionId,
    /// The card.
    pub approval_request_id: ApprovalRequestId,
    /// The workflow run whose wait holds the card.
    pub workflow_run_id: WorkflowRunId,
    /// The wait.
    pub wait_id: UuidTextForm,
    /// The step's node; absent on a chain's question.
    pub node_id: Option<WorkflowNodeId>,
    /// What the card is about.
    pub category: ApprovalCategory,
    /// Its target scope.
    pub scope: ApprovalScope,
    /// What the card drew.
    pub resource_descriptor: JsonRecord,
    /// The answer.
    pub decision: ApprovalDecision,
    /// The `why not` words, on a decline the person typed them on.
    pub decline_reason: Option<NonEmptyText>,
    /// The device that answered.
    pub device_id: DeviceId,
    /// When the answer was given, the instant its record carries.
    pub resolved_at: WireInstant,
    /// The card's settle, refused unless it is still pending, and its resolution row.
    pub statements: Vec<WriteStatement>,
    /// The `approval.approved` or `approval.rejected` event the write appends.
    pub event: SessionEvent,
}

impl ApprovalWaitAnswer {
    /// The answer `resolution` to the wait-held card `stored`, the event `payload` and the write
    /// that settles the card.
    pub(crate) fn of(
        stored: &StoredApprovalRequest,
        workflow_run_id: WorkflowRunId,
        wait_id: UuidTextForm,
        node_id: Option<WorkflowNodeId>,
        payload: ApprovalResolvedPayload,
        resolution: &InsertedApprovalResolution,
    ) -> Self {
        Self {
            session_id: stored.session_id,
            approval_request_id: stored.approval_request_id,
            workflow_run_id,
            wait_id,
            node_id,
            category: stored.category,
            scope: stored.scope.clone(),
            resource_descriptor: stored.resource_descriptor.to_record(),
            decision: resolution.decision,
            decline_reason: resolution.decline_reason.clone(),
            device_id: resolution.device_id.clone(),
            resolved_at: resolution.resolved_at.clone(),
            statements: vec![
                settle_pending_statement(
                    &stored.approval_request_id,
                    ApprovalSettlement::Decided(resolution.decision),
                    &resolution.resolved_at,
                ),
                insert_resolution_statement(resolution),
            ],
            event: resolved_event(resolution.decision)(payload),
        }
    }
}

/// How a workflow wait took an answer to its card.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalWaitOutcome {
    /// The step's write committed with the answer's write, settling the card.
    Settled,
    /// No step waits on the wait any more, so nothing was written.
    NotWaiting,
}

/// The workflow waits' intake of an answer to a card a wait holds, registered through the
/// approval service's `PortRegistration` by the workflow engine.
pub trait ApprovalWaits: Send + Sync {
    /// Settles the card `answer` names in its step's write and answers how the wait took it. An
    /// error when the wait could not take it.
    fn answer_wait(
        &self,
        answer: ApprovalWaitAnswer,
    ) -> BoxFuture<'_, Result<ApprovalWaitOutcome, Box<dyn Error + Send + Sync>>>;
}

impl ApprovalService {
    /// Raises the card `ask` names and answers its id, or answers the id of the card its wait
    /// already holds open, a second raise for one wait raising none. Its answer goes through the
    /// registered [`ApprovalWaits`], so no in-process wait is armed. A raise whose insert lost to
    /// another raise's card, settled before it was read back, raises once more. Refuses
    /// `approval.requestCanceled` with its `reason` when the session has closed, or when a step
    /// card's workflow run has finished or a chain card's question no longer waits in the session,
    /// the session's own refusal of the write, and `approval.persistenceUnavailable` when the
    /// record could not be kept.
    pub async fn raise_workflow_gate(
        &self,
        ask: WorkflowGateCardAsk,
    ) -> Result<ApprovalRequestId, ApprovalServiceError> {
        let mut is_retry = false;
        loop {
            if let Some(open) = self
                .read_open_wait_card(ask.session_id, ask.wait_id)
                .await?
            {
                return Ok(open.approval_request_id);
            }
            match self.write_workflow_gate(ask.clone()).await? {
                GateWrite::Raised(approval_request_id) => return Ok(approval_request_id),
                GateWrite::LostInsert(_) if !is_retry => is_retry = true,
                GateWrite::LostInsert(failure) => {
                    return Err(refusal_of_failed_write(failure).into());
                }
            }
        }
    }

    // One write of the card `ask` names, refused as [`ApprovalService::raise_workflow_gate`]
    // says but for an insert that lost to another raise's card.
    async fn write_workflow_gate(
        &self,
        ask: WorkflowGateCardAsk,
    ) -> Result<GateWrite, ApprovalServiceError> {
        let WorkflowGateCardAsk {
            session_id,
            workflow_run_id,
            wait_id,
            node_id,
            workflow_name,
            prompt,
        } = ask;
        let holder_statement =
            wait_holder_statement(&session_id, &workflow_run_id, node_id.as_ref());
        let approval_request_id =
            ApprovalRequestId::try_from(mint_uuid_v7()).expect("a minted UUID is an ask's id");
        let created_at = WireInstant::now();
        let holder = ApprovalHolder::Wait {
            workflow_run_id,
            wait_id,
            node_id,
        };
        let requested_by = NonEmptyText::new(workflow_name.as_str().to_owned())
            .expect("free-form text holds a code point");
        let scope = ApprovalScope::new(session_id.text().as_str().to_owned())
            .expect("a session id is free-form text");
        let resource_descriptor = ApprovalResourceDescriptor {
            subject: workflow_name,
            standing_allow_offered: false,
            project_scope_offered: false,
            editable: false,
            action: None,
            tool_name: None,
            tool_server_tool: None,
            prompt: Some(prompt),
        };
        let payload = ApprovalRequestedPayload {
            session_id,
            holder: holder.clone(),
            approval_request_id,
            category: ApprovalCategory::Gate,
            scope: scope.clone(),
            requested_by: requested_by.clone(),
            resource_descriptor: resource_descriptor.to_record(),
            ask_id: None,
            tool_call_id: None,
            input_digest: None,
        };
        let inserted = InsertedApprovalRequest {
            approval_request_id,
            session_id,
            holder: holder.clone(),
            requested_by,
            category: ApprovalCategory::Gate,
            scope,
            resource_descriptor,
            ask_id: None,
            tool_call_id: None,
            input_digest: None,
            created_at: created_at.clone(),
        };
        let draft = SessionEventDraft::new(payload, SessionEvent::ApprovalRequested)?;
        let linkage = SessionEventLinkage {
            occurred_at: Some(created_at),
            transactional_prelude: vec![
                session_open_statement(&session_id),
                holder_statement,
                insert_wait_request_statement(&inserted),
            ],
            ..SessionEventLinkage::default()
        };
        let Err(failure) = self.events.append(draft, linkage).await else {
            return Ok(GateWrite::Raised(approval_request_id));
        };
        let refusal = match failure.refused_statement_index() {
            Some(GATE_SESSION_OPEN_GUARD_INDEX) => {
                approval_late_create(session_id, &holder, ApprovalLateCreateReason::SessionClosed)
            }
            Some(GATE_HOLDER_GUARD_INDEX) => {
                approval_late_create(session_id, &holder, ApprovalLateCreateReason::RunEnded)
            }
            // Another raise for the wait wrote its card between the read and this write.
            Some(GATE_INSERT_INDEX) => return Ok(GateWrite::LostInsert(failure)),
            Some(_) | None => refusal_of_failed_write(failure),
        };
        Err(refusal.into())
    }

    /// Withdraws the cards the waits `wait_ids` hold open in `session_id`, once their waits ended
    /// unanswered: the open cards are read in one read, then each card's `approval.canceled` is
    /// queued with none awaited before the next, so the writer commits them together while each
    /// keeps its own guard. An answer that landed first keeps its card and refuses no other
    /// card's cancel, and a wait with no open card writes nothing. Answers one result per wait, in
    /// order, a cancel not kept failing its own; fails, with nothing written, when the read fails.
    pub async fn withdraw_workflow_gates(
        &self,
        session_id: SessionId,
        wait_ids: Vec<UuidTextForm>,
    ) -> Result<Vec<Result<(), ApprovalServiceError>>, ApprovalServiceError> {
        let open_cards = self.read_open_wait_cards(session_id, wait_ids).await?;
        Ok(join_all(open_cards.iter().map(|open| async move {
            match open {
                Some(open) => self.cancel(open, None).await.map(drop),
                None => Ok(()),
            }
        }))
        .await)
    }

    // The card the wait holds open, through the open wait's unique index.
    async fn read_open_wait_card(
        &self,
        session_id: SessionId,
        wait_id: UuidTextForm,
    ) -> Result<Option<StoredApprovalRequest>, ApprovalServiceError> {
        self.read(move |reader| reader.read_open_wait_request(&session_id, &wait_id))
            .await
    }

    // The card each wait holds open, as one wait's read finds it, all in one read.
    async fn read_open_wait_cards(
        &self,
        session_id: SessionId,
        wait_ids: Vec<UuidTextForm>,
    ) -> Result<Vec<Option<StoredApprovalRequest>>, ApprovalServiceError> {
        self.read(move |reader| {
            wait_ids
                .iter()
                .map(|wait_id| reader.read_open_wait_request(&session_id, wait_id))
                .collect()
        })
        .await
    }

    /// Hands `wait_answer`, the answer to the wait-held card `stored`, to the registered waits,
    /// writing nothing itself. A card whose wait no longer waits is canceled and refused
    /// `approval.requestCanceled`, or, settled first by another answer, answered as that answer's
    /// read back is. Fails when the waits are not registered or could not take the answer.
    pub(crate) async fn hand_wait_answer(
        &self,
        stored: StoredApprovalRequest,
        answer: &ResolveAnswer<'_>,
        wait_answer: ApprovalWaitAnswer,
        resolution: InsertedApprovalResolution,
    ) -> Result<ResolvedAnswer, ApprovalServiceError> {
        let outcome = self
            .waits()
            .require_port()?
            .answer_wait(wait_answer)
            .await
            .map_err(ApprovalServiceError::Wait)?;
        match outcome {
            ApprovalWaitOutcome::Settled => {
                if resolution.decision == ApprovalDecision::Approved {
                    self.mark_working_folder_stale(stored.session_id).await;
                }
                Ok(resolved_answer_of(stored, resolution, false))
            }
            ApprovalWaitOutcome::NotWaiting => {
                if self.cancel(&stored, None).await? {
                    return Err(approval_request_canceled(stored.approval_request_id).into());
                }
                self.read_back_settled(answer).await
            }
        }
    }
}

#[cfg(test)]
mod tests;
