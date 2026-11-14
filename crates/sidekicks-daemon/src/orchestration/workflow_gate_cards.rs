//! A workflow's approval waits as approval cards: each wait's card raised once in its run's session
//! under its workflow's name, withdrawn once its wait ends unanswered, and the card's answer made
//! the gate's answer, which the engine settles with the card in the step's own write.

use std::error::Error;
use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde_json::json;
use sidekicks_approval::service::ApprovalService;
use sidekicks_approval::workflow_gate::{
    ApprovalWaitAnswer, ApprovalWaitOutcome, ApprovalWaits, WorkflowGateCardAsk,
};
use sidekicks_contracts::approval::{ApprovalCategory, ApprovalDecision};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::{UuidTextForm, mint_uuid_v7};
use sidekicks_contracts::wire::text::{FreeFormText, NonEmptyText};
use sidekicks_contracts::workflow::run::gate_resolution::{
    WorkflowGateApprovalCategory, WorkflowGateKind, WorkflowGateResolutionId,
};
use sidekicks_workflow::engine::ports::{
    ApprovalCardRaiser, PortError, WorkflowApprovalCardRequest,
};
use sidekicks_workflow::engine::waits::PersonWaitRefusal;
use sidekicks_workflow::engine::waits::answers::{EngineAnswers, WaitAnswerError};
use sidekicks_workflow::runs::gate_resolution::{ApprovalCardAnswer, WorkflowGateAnswer};

/// The bridge between the workflow engine's approval waits and the approval cards: it raises and
/// withdraws each wait's card and hands the card's answers to the engine.
#[expect(
    dead_code,
    reason = "the workflow engine's composition, which builds the bridge and registers it"
)]
pub(crate) struct WorkflowGateCards {
    approvals: Arc<ApprovalService>,
    answers: EngineAnswers,
}

impl WorkflowGateCards {
    /// The bridge raising through `approvals` and answering through the engine's `answers`.
    #[expect(
        dead_code,
        reason = "the workflow engine's composition, which builds the bridge and registers it"
    )]
    pub(crate) fn new(approvals: Arc<ApprovalService>, answers: EngineAnswers) -> Self {
        Self { approvals, answers }
    }
}

/// A chain card's Decline, `Stop them all`, which stops every run of the chain through the run
/// controls rather than through a wait's answer, so this bridge does not take it.
#[derive(Debug, thiserror::Error)]
#[error("a chain card's Decline stops the chain through the run controls, not a wait's answer")]
#[expect(
    dead_code,
    reason = "the workflow engine's composition, which builds the bridge and registers it"
)]
struct ChainDeclineNotAWaitAnswer;

impl ApprovalCardRaiser for WorkflowGateCards {
    fn raise(&self, request: WorkflowApprovalCardRequest) -> BoxFuture<'_, Result<(), PortError>> {
        async move {
            let ask = WorkflowGateCardAsk {
                session_id: request.session_id,
                workflow_run_id: request.run_id,
                wait_id: request.wait_id,
                node_id: request.step.map(|step| step.node_id),
                workflow_name: FreeFormText::new(request.workflow_name.into_string())?,
                prompt: NonEmptyText::new(request.prompt.as_str().to_owned())
                    .expect("composed text holds a code point"),
            };
            self.approvals.raise_workflow_gate(ask).await?;
            Ok(())
        }
        .boxed()
    }

    fn withdraw(
        &self,
        session_id: SessionId,
        wait_ids: Vec<UuidTextForm>,
    ) -> BoxFuture<'_, Result<Vec<Result<(), PortError>>, PortError>> {
        async move {
            let withdrawn = self
                .approvals
                .withdraw_workflow_gates(session_id, wait_ids)
                .await?;
            Ok(withdrawn
                .into_iter()
                .map(|card| card.map_err(PortError::from))
                .collect())
        }
        .boxed()
    }
}

impl ApprovalWaits for WorkflowGateCards {
    fn answer_wait(
        &self,
        answer: ApprovalWaitAnswer,
    ) -> BoxFuture<'_, Result<ApprovalWaitOutcome, Box<dyn Error + Send + Sync>>> {
        async move {
            let wait_id = answer.wait_id;
            let (gate, card) = gate_answer(answer);
            let answered = match (gate.gate, gate.outcome) {
                (WorkflowGateKind::HumanApproval, _) => {
                    self.answers.answer_gate(wait_id, gate, card).await
                }
                (WorkflowGateKind::Chain, ApprovalDecision::Approved) => {
                    self.answers.keep_going(gate, card).await
                }
                (WorkflowGateKind::Chain, ApprovalDecision::Rejected) => {
                    return Err(ChainDeclineNotAWaitAnswer.into());
                }
            };
            wait_outcome(answered)
        }
        .boxed()
    }
}

/// How the card reads the engine's answer `answered` to its wait: settled when the step's write
/// committed, not waiting when its held run's step had left the wait; a wait no held run waits on
/// and a closed engine are errors, the card left pending.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the workflow engine's composition, which builds the bridge and registers it"
    )
)]
fn wait_outcome(
    answered: Result<(), WaitAnswerError>,
) -> Result<ApprovalWaitOutcome, Box<dyn Error + Send + Sync>> {
    match answered {
        Ok(()) => Ok(ApprovalWaitOutcome::Settled),
        Err(WaitAnswerError::Refused(PersonWaitRefusal::NotWaiting)) => {
            Ok(ApprovalWaitOutcome::NotWaiting)
        }
        Err(refused @ WaitAnswerError::Refused(PersonWaitRefusal::NotHeld)) => Err(refused.into()),
        Err(closed @ WaitAnswerError::Closed) => Err(closed.into()),
    }
}

/// The gate's answer and the card's own that `answer` makes: a step's card answers its
/// `human.approval` gate naming its node, and a chain's card its chain gate naming none, under a
/// freshly minted resolution id; the decision's context holds the card's scope, its resource and
/// the person's decline words where they typed some.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the workflow engine's composition, which builds the bridge and registers it"
    )
)]
fn gate_answer(answer: ApprovalWaitAnswer) -> (WorkflowGateAnswer, ApprovalCardAnswer) {
    let ApprovalWaitAnswer {
        approval_request_id,
        workflow_run_id,
        node_id,
        category,
        scope,
        resource_descriptor,
        decision,
        decline_reason,
        device_id,
        resolved_at,
        statements,
        event,
        ..
    } = answer;
    let mut decision_context = json!({ "scope": scope, "resourceDescriptor": resource_descriptor });
    if let Some(words) = decline_reason {
        decision_context["declineReason"] = json!(words);
    }
    let gate = WorkflowGateAnswer {
        gate_resolution_id: WorkflowGateResolutionId::try_from(mint_uuid_v7())
            .expect("a minted UUID is an answer's id"),
        workflow_run_id,
        gate: match node_id {
            Some(_) => WorkflowGateKind::HumanApproval,
            None => WorkflowGateKind::Chain,
        },
        node_id,
        approval_category: Some(gate_category(category)),
        approval_request_id,
        outcome: decision,
        device_id,
        resolved_at,
        decision_context: serde_json::from_value(decision_context)
            .expect("the decision's context is a record"),
    };
    (gate, ApprovalCardAnswer { statements, event })
}

/// The gate row's word for the card's category.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the workflow engine's composition, which builds the bridge and registers it"
    )
)]
fn gate_category(category: ApprovalCategory) -> WorkflowGateApprovalCategory {
    match category {
        ApprovalCategory::ToolExecution => WorkflowGateApprovalCategory::ToolExecution,
        ApprovalCategory::FileWrite => WorkflowGateApprovalCategory::FileWrite,
        ApprovalCategory::NetworkAccess => WorkflowGateApprovalCategory::NetworkAccess,
        ApprovalCategory::DestructiveGit => WorkflowGateApprovalCategory::DestructiveGit,
        ApprovalCategory::Gate => WorkflowGateApprovalCategory::Gate,
    }
}

#[cfg(test)]
mod tests;
