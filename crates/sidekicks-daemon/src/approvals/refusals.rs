//! The approval service's refusals, each sent on the wire by its code: an ask the daemon holds no
//! row for, one already answered or canceled, an answer that does not fit its ask, an ask raised
//! after its run or its session ended, a record that could not be kept, a rule the provider could
//! not keep after the answer reached it, an `Allow once` on a block the daemon holds no record of
//! or no person may overrule, and a revoke of a rule never made, no longer in force, or that could
//! not be taken out of a project's rule file.

use std::error::Error;

use serde_json::json;
use sidekicks_contracts::approval::{
    ApprovalLateCreateReason, ApprovalRequestId, ApprovalResolutionInvalidReason, RememberedRuleId,
    ReviewerDenialId,
};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;

use sidekicks_ipc::domain_error::DomainError;

/// `approval.notFound`: the daemon holds no ask under `approval_request_id`.
pub(crate) fn approval_not_found(approval_request_id: ApprovalRequestId) -> DomainError {
    DomainError::new(
        "This session holds no such approval request",
        RefusalCode::ApprovalNotFound,
    )
    .with_detail(json!({ "approvalRequestId": approval_request_id }))
}

/// `approval.alreadyResolved`: another answer settled the ask first, and it stands.
pub(crate) fn approval_already_resolved(approval_request_id: ApprovalRequestId) -> DomainError {
    DomainError::new(
        "The approval request was already answered",
        RefusalCode::ApprovalAlreadyResolved,
    )
    .with_detail(json!({ "approvalRequestId": approval_request_id }))
}

/// `approval.requestCanceled` on an answer: the ask was canceled and can no longer be answered.
pub(crate) fn approval_request_canceled(approval_request_id: ApprovalRequestId) -> DomainError {
    DomainError::new(
        "The approval request was canceled and can no longer be answered",
        RefusalCode::ApprovalRequestCanceled,
    )
    .with_detail(json!({ "approvalRequestId": approval_request_id }))
}

/// `approval.requestCanceled` on a create: the run had ended or the session had closed, so no ask
/// was raised; `reason` names which, read from their state when the create was refused.
pub(crate) fn approval_late_create(
    session_id: SessionId,
    run_id: RunId,
    reason: ApprovalLateCreateReason,
) -> DomainError {
    let message = match reason {
        ApprovalLateCreateReason::RunEnded => "The run has ended, so it raises no approval request",
        ApprovalLateCreateReason::SessionClosed => {
            "The session is closed, so it raises no approval request"
        }
    };
    DomainError::new(message, RefusalCode::ApprovalRequestCanceled).with_detail(json!({
        "sessionId": session_id,
        "runId": run_id,
        "reason": reason,
    }))
}

/// `approval.resolutionInvalid`: the answer does not fit the ask it names, so nothing was
/// recorded; `reason` names how.
pub(crate) fn approval_resolution_invalid(
    approval_request_id: ApprovalRequestId,
    reason: ApprovalResolutionInvalidReason,
) -> DomainError {
    DomainError::new(
        "The answer does not fit the approval request it names",
        RefusalCode::ApprovalResolutionInvalid,
    )
    .with_detail(json!({ "approvalRequestId": approval_request_id, "reason": reason }))
}

/// `approval.persistenceUnavailable`: the approval record could not be written, so the action it
/// gates does not proceed; `cause`, the write's own failure, is kept for the service log.
pub(crate) fn approval_persistence_unavailable(
    cause: impl Into<Box<dyn Error + Send + Sync>>,
) -> DomainError {
    DomainError::new(
        "The approval record could not be kept, so the action does not proceed",
        RefusalCode::ApprovalPersistenceUnavailable,
    )
    .with_source(cause)
}

/// `approval.rule.notKept`: the answer was recorded and reached the provider, which runs or
/// refuses the call on it, but the provider could not keep the rule the answer asked for, so none
/// was recorded; `cause`, the provider's failure, is kept for the service log.
pub(crate) fn approval_rule_not_kept(
    approval_request_id: ApprovalRequestId,
    cause: impl Into<Box<dyn Error + Send + Sync>>,
) -> DomainError {
    DomainError::new(
        "The answer went through, but its rule could not be kept, so no rule was made",
        RefusalCode::ApprovalRuleNotKept,
    )
    .with_detail(json!({ "approvalRequestId": approval_request_id }))
    .with_source(cause)
}

/// `approval.rule.notKept` on a revoke: the rule could not be taken out of a project's rule file,
/// so it still applies there and no revoke was recorded; `cause`, the provider's failure, is kept
/// for the service log.
pub(crate) fn approval_rule_revoke_not_kept(
    rule_id: RememberedRuleId,
    cause: impl Into<Box<dyn Error + Send + Sync>>,
) -> DomainError {
    DomainError::new(
        "The rule could not be taken out of a project's rule file, so it still applies there",
        RefusalCode::ApprovalRuleNotKept,
    )
    .with_detail(json!({ "ruleId": rule_id }))
    .with_source(cause)
}

/// `approval.denial.notFound`: the daemon holds no block by a reviewer under `denial_id`.
pub(crate) fn reviewer_denial_not_found(
    session_id: SessionId,
    denial_id: ReviewerDenialId,
) -> DomainError {
    DomainError::new(
        "This session holds no such blocked action",
        RefusalCode::ApprovalDenialNotFound,
    )
    .with_detail(json!({ "sessionId": session_id, "denialId": denial_id }))
}

/// `approval.denial.notOverridable`: the provider lets no person overrule this block.
pub(crate) fn reviewer_denial_not_overridable(
    session_id: SessionId,
    denial_id: ReviewerDenialId,
) -> DomainError {
    DomainError::new(
        "The provider lets no one allow this blocked action",
        RefusalCode::ApprovalDenialNotOverridable,
    )
    .with_detail(json!({ "sessionId": session_id, "denialId": denial_id }))
}

/// `approval.rule.notFound`: no rule was ever made under `rule_id`.
pub(crate) fn approval_rule_not_found(rule_id: RememberedRuleId) -> DomainError {
    DomainError::new("No such rule was made", RefusalCode::ApprovalRuleNotFound)
        .with_detail(json!({ "ruleId": rule_id }))
}

/// `approval.rule.alreadyRevoked`: the rule is no longer in force.
pub(crate) fn approval_rule_already_revoked(rule_id: RememberedRuleId) -> DomainError {
    DomainError::new(
        "The rule was already revoked",
        RefusalCode::ApprovalRuleAlreadyRevoked,
    )
    .with_detail(json!({ "ruleId": rule_id }))
}
