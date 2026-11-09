//! The approval seam the callback-tool host asks before it runs one of the app's own tools. Each
//! tool is gated as it was declared:
//!
//! - A read tool runs as the session's own call at every level.
//! - A tool that acts, such as messaging another session or driving the browser, is gated by the
//!   calling session's level alone: at a level that asks, the person's card, and at Sandboxed and
//!   YOLO no card.
//! - A tool that starts a workflow takes that same gate first, then the workflow rules' start
//!   decision under the asking run's posture.
//!
//! A workflow step's file write, tool call, command or program takes the same card, gated by the
//! run's level instead, and hears its settlement whole: a decline reaches the step with its words
//! and its instant, apart from a refusal.
//!
//! The card is the daemon's to raise only where the provider runs the tool without asking first;
//! a provider whose driver has it ask before each of the app's own tools has asked already. A tool
//! with no declared gate is refused, so no tool runs unadjudicated.

use std::collections::HashMap;
use std::error::Error;
use std::sync::Arc;

use futures::future::BoxFuture;
use sidekicks_agent::tools::gate::CallbackToolGate;
use sidekicks_contracts::approval::ApprovalDecision;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_provider::callback_tools::host::{
    CallbackToolApprovalBasis, CallbackToolApprovalOutcome, CallbackToolApprovalSeam,
    CallbackToolPortError,
};
use sidekicks_provider::driver::callback_tool::CallbackToolInvocation;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_workflow::runs::step_action::{
    StepActionApproval, StepActionCheck, StepActionVerdict,
};

use crate::permission_check::{PermissionCheck, ToolCallVerdict, WorkflowStartVerdict};
use crate::service::{RaisedCard, RaisedRequestSettlement};

/// What the agent reads when its call names a tool no gate was declared for.
pub(crate) const UNGATED_TOOL_REFUSAL: &str = "This tool has no approval gate, so it does not run.";

/// What the agent reads when its call names no workflow to start.
pub(crate) const NO_WORKFLOW_REFUSAL: &str = "This call names no workflow to start.";

/// What the agent reads when the person declined the call on its card and typed no words.
pub(crate) const DECLINED_REFUSAL: &str = "The person declined this call.";

/// What the agent reads when the call's card ended unanswered with its run or its session.
pub(crate) const CANCELED_REFUSAL: &str =
    "This call's approval ended unanswered, so it did not run.";

/// What a workflow step reads when its action's card ended unanswered with its run or session.
pub(crate) const CANCELED_STEP_REFUSAL: &str =
    "This step's approval ended unanswered, so its action did not run.";

/// Why the seam could not adjudicate a call, which the host answers `denied`.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CallbackToolApprovalError {
    /// The daemon stopped before the call's card settled.
    #[error("the daemon stopped before the call's approval settled")]
    Stopped,
}

/// The callback-tool host's approval seam, over the permission check and the gate each of the
/// app's own tools was declared with.
pub(crate) struct CallbackToolApprovals {
    /// Decides the level's gate and a workflow start.
    check: Arc<PermissionCheck>,
    /// Whose descriptor says whether a provider asks before the app's tools itself.
    providers: Arc<ProviderRegistry>,
    /// Each tool's gate by its name.
    gates_by_tool: HashMap<String, CallbackToolGate>,
}

impl CallbackToolApprovals {
    /// The seam over `check`, reading each provider's facts from `providers`, gating each tool as
    /// `gates_by_tool` declares it.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the agent tool server's gate map")
    )]
    pub(crate) fn new(
        check: Arc<PermissionCheck>,
        providers: Arc<ProviderRegistry>,
        gates_by_tool: HashMap<String, CallbackToolGate>,
    ) -> Self {
        Self {
            check,
            providers,
            gates_by_tool,
        }
    }

    async fn adjudicate(
        &self,
        invocation: &CallbackToolInvocation,
        provider: &ProviderId,
    ) -> Result<CallbackToolApprovalOutcome, CallbackToolPortError> {
        let Some(gate) = self.gates_by_tool.get(invocation.tool_name.as_str()) else {
            return Ok(deny_by_policy(UNGATED_TOOL_REFUSAL));
        };
        let workflow_id = match gate {
            CallbackToolGate::Read => {
                return Ok(CallbackToolApprovalOutcome::Allow {
                    basis: CallbackToolApprovalBasis::Policy,
                });
            }
            CallbackToolGate::Level => None,
            // Read before any card, so a call naming no workflow asks the person nothing.
            CallbackToolGate::WorkflowStart { workflow_id_of } => {
                match workflow_id_of(&invocation.arguments) {
                    Some(workflow_id) => Some(workflow_id),
                    None => return Ok(deny_by_policy(NO_WORKFLOW_REFUSAL)),
                }
            }
        };
        let level_outcome = self.apply_level(invocation, provider).await?;
        let Some(workflow_id) = workflow_id else {
            return Ok(level_outcome);
        };
        if let CallbackToolApprovalOutcome::Deny { .. } = level_outcome {
            return Ok(level_outcome);
        }
        Ok(
            match self
                .check
                .check_workflow_start(&workflow_id, invocation.run_id)
                .await?
            {
                WorkflowStartVerdict::Allowed => level_outcome,
                WorkflowStartVerdict::Denied { refusal } => deny_by_policy(refusal),
            },
        )
    }

    // The session's level over a call that acts: where the provider asked already it stands, else
    // the check raises the card at a level that asks and the call waits on the person's answer.
    async fn apply_level(
        &self,
        invocation: &CallbackToolInvocation,
        provider: &ProviderId,
    ) -> Result<CallbackToolApprovalOutcome, CallbackToolPortError> {
        if self.providers.descriptor(provider)?.callback_tools_asked {
            return Ok(CallbackToolApprovalOutcome::Allow {
                basis: CallbackToolApprovalBasis::Policy,
            });
        }
        match self.check.check_tool_call(invocation).await? {
            ToolCallVerdict::Settled(outcome) => Ok(outcome),
            ToolCallVerdict::CardRaised(card) => settle_card(card).await,
        }
    }

    // A step's action as the check settles it, or as the person answers its card.
    async fn decide_step_action(
        &self,
        check: StepActionCheck,
    ) -> Result<StepActionVerdict, Box<dyn Error + Send + Sync>> {
        match self.check.check_step_action(check).await? {
            ToolCallVerdict::Settled(CallbackToolApprovalOutcome::Allow { .. }) => {
                Ok(StepActionVerdict::Allowed)
            }
            ToolCallVerdict::Settled(CallbackToolApprovalOutcome::Deny { reason, .. }) => {
                Ok(StepActionVerdict::Refused { reason })
            }
            ToolCallVerdict::CardRaised(card) => Ok(answer_of(card).await?),
        }
    }
}

impl StepActionApproval for CallbackToolApprovals {
    /// Decides a workflow step's action, waiting on the person's answer where the run's level
    /// asks: allowed, declined on its card with the person's words and the decline's instant, or
    /// refused with what the step reads. Fails when the daemon stops before the card settles.
    fn check_step_action(
        &self,
        check: StepActionCheck,
    ) -> BoxFuture<'_, Result<StepActionVerdict, Box<dyn Error + Send + Sync>>> {
        Box::pin(self.decide_step_action(check))
    }
}

impl CallbackToolApprovalSeam for CallbackToolApprovals {
    fn evaluate<'a>(
        &'a self,
        invocation: &'a CallbackToolInvocation,
        provider: &'a ProviderId,
    ) -> BoxFuture<'a, Result<CallbackToolApprovalOutcome, CallbackToolPortError>> {
        Box::pin(self.adjudicate(invocation, provider))
    }
}

// The person's answer on the daemon's own card, for a step's card and an agent tool's alike, in
// the step's verdict, which `settle_card` maps onto an agent's call: approved runs, declined
// carries the words they typed and the decline's instant, and a card that ended with its run or
// session refuses in a step's words. Fails when the daemon stops before the card settles.
async fn answer_of(card: RaisedCard) -> Result<StepActionVerdict, CallbackToolApprovalError> {
    match card.settled.settled().await {
        RaisedRequestSettlement::Approved => Ok(StepActionVerdict::Allowed),
        RaisedRequestSettlement::Rejected {
            decline_reason,
            resolved_at,
        } => Ok(StepActionVerdict::Declined {
            words: decline_reason,
            at: resolved_at,
        }),
        RaisedRequestSettlement::Canceled => Ok(StepActionVerdict::Refused {
            reason: CANCELED_STEP_REFUSAL.to_owned(),
        }),
        RaisedRequestSettlement::Stopped => Err(CallbackToolApprovalError::Stopped),
    }
}

// The person's answer on the daemon's own card, as an agent's call reads it: a decline carries
// the words they typed, and a card that ended unanswered refuses in the agent's words.
async fn settle_card(
    card: RaisedCard,
) -> Result<CallbackToolApprovalOutcome, CallbackToolPortError> {
    Ok(match answer_of(card).await? {
        StepActionVerdict::Allowed => decided_outcome(ApprovalDecision::Approved, None),
        StepActionVerdict::Declined { words, .. } => {
            decided_outcome(ApprovalDecision::Rejected, words)
        }
        StepActionVerdict::Refused { .. } => deny_by_policy(CANCELED_REFUSAL),
    })
}

/// What a call reads of the person's `decision` on the daemon's own card: approved runs, and
/// declined carries the words they typed, `decline_reason`, where they typed any.
pub(crate) fn decided_outcome(
    decision: ApprovalDecision,
    decline_reason: Option<NonEmptyText>,
) -> CallbackToolApprovalOutcome {
    match decision {
        ApprovalDecision::Approved => CallbackToolApprovalOutcome::Allow {
            basis: CallbackToolApprovalBasis::UserGrant,
        },
        ApprovalDecision::Rejected => CallbackToolApprovalOutcome::Deny {
            basis: CallbackToolApprovalBasis::UserRefusal,
            reason: decline_reason.map_or_else(
                || DECLINED_REFUSAL.to_owned(),
                |words| words.as_str().to_owned(),
            ),
        },
    }
}

fn deny_by_policy(reason: &str) -> CallbackToolApprovalOutcome {
    CallbackToolApprovalOutcome::Deny {
        basis: CallbackToolApprovalBasis::Policy,
        reason: reason.to_owned(),
    }
}

#[cfg(test)]
mod tests;
