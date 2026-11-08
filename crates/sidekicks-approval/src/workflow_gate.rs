//! A workflow gate's approval card: the card a workflow's approval step or chain question raises,
//! held by its workflow wait rather than an agent run. Its answer is handed with its write to the
//! workflow engine, which settles the card in the step's own write, so the card, the gate's record
//! and the step's resume land together.

use std::error::Error;

use futures::future::BoxFuture;
use sidekicks_contracts::approval::events::ApprovalResolvedPayload;
use sidekicks_contracts::approval::{
    ApprovalCategory, ApprovalDecision, ApprovalRequestId, ApprovalScope,
};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::UuidTextForm;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::record::JsonRecord;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::definition::document::WorkflowNodeId;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_store::database::statement::WriteStatement;

use crate::events::resolved_event;
use crate::refusals::approval_request_canceled;
use crate::service::{
    ApprovalService, ApprovalServiceError, ResolveAnswer, ResolvedAnswer, resolved_answer_of,
};
use crate::store::{
    ApprovalSettlement, InsertedApprovalResolution, StoredApprovalRequest,
    insert_resolution_statement, settle_pending_statement,
};

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
