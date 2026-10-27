//! The approval tables as a rebuild writes them from the session's log: each ask from its
//! `approval.requested`, with the daemon's own ask id that routes its answer back to the provider
//! ask it was raised for; each answer from its `approval.approved` or `approval.rejected`; each
//! cancellation from its `approval.canceled`; and the rule an answer made from its
//! `approval.rule.remembered`. Every row is written at the event's own instant with the columns its
//! live write wrote, through the live write's own guards, so the rows a rebuild writes are the rows
//! the live writes wrote. The category's other events write no approval row: a rule's revocation
//! and a reviewer's block live with the provider and in their own table.
//!
//! An ask a workflow gate's answer names keeps its row and its answer through the clear, which
//! skips the asks `GATE_NAMED_ASKS_SQL` reads, since the gate's row names the ask by its id and no
//! rebuild writes the gate's rows; the fold writes both over as it reaches them. Such an ask whose
//! answer the fold never reaches, its answer in a range the session skipped as damaged, settles as
//! the gate's row says, the later fact.

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::types::Value;
use sidekicks_contracts::approval::events::ApprovalResolvedPayload;
use sidekicks_contracts::approval::{ApprovalDecision, ApprovalState};
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;

use crate::request_create::ApprovalResourceDescriptor;
use crate::store::{
    ApprovalSettlement, InsertedApprovalRequest, InsertedApprovalResolution,
    remembered_scope_statement, rewrite_request_statement, rewrite_resolution_statement,
    settle_pending_statement,
};
use sidekicks_store::database::statement::{StatementBindings, WriteStatement};
use sidekicks_store::events::projection::{
    ProjectionContradiction, SessionProjection, SessionProjectionFold,
};

// The asks a workflow gate's answer names, which outlive the clear.
const GATE_NAMED_ASKS_SQL: &str = "SELECT approval_request_id FROM workflow_gate_resolutions";

// The session's answers, but those of the asks the clear keeps.
static CLEAR_RESOLUTIONS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "DELETE FROM approval_resolutions
  WHERE request_id IN (SELECT id FROM approval_requests
                        WHERE session_id = ? AND id NOT IN ({GATE_NAMED_ASKS_SQL}))"
    )
});

static CLEAR_REQUESTS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "DELETE FROM approval_requests
  WHERE session_id = ? AND id NOT IN ({GATE_NAMED_ASKS_SQL})"
    )
});

// Each of the session's asks a gate's answer names that the fold left pending takes the newest
// gate answer's outcome and instant, the words a decision and an ask's state share.
static SETTLE_AS_GATES_ANSWERED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE approval_requests
  SET (state, updated_at) = (SELECT gate.outcome, gate.resolved_at
                               FROM workflow_gate_resolutions AS gate
                              WHERE gate.approval_request_id = approval_requests.id
                              ORDER BY gate.resolved_at DESC, gate.sequence DESC
                              LIMIT 1)
  WHERE session_id = ? AND state = '{}' AND id IN ({GATE_NAMED_ASKS_SQL})",
        <&str>::from(ApprovalState::Pending)
    )
});

// Every type the fold reads: an ask, its answer either way, its cancellation and its rule.
const APPROVALS_EVENT_TYPES: [SessionEventType; 5] = [
    SessionEventType::ApprovalRequested,
    SessionEventType::ApprovalApproved,
    SessionEventType::ApprovalRejected,
    SessionEventType::ApprovalCanceled,
    SessionEventType::ApprovalRuleRemembered,
];

/// The `approval_requests` and `approval_resolutions` rows as a rebuild replaces them. Its fold
/// keeps no state, so the projection is its own fold.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ApprovalsProjection;

impl SessionProjection for ApprovalsProjection {
    fn name(&self) -> &'static str {
        "approvals"
    }

    fn event_types(&self) -> &[SessionEventType] {
        &APPROVALS_EVENT_TYPES
    }

    fn clear_statements(&self, session_id: &SessionId) -> Vec<WriteStatement> {
        vec![
            session_statement(&CLEAR_RESOLUTIONS_SQL, session_id),
            session_statement(&CLEAR_REQUESTS_SQL, session_id),
        ]
    }

    fn closing_statements(&self, session_id: &SessionId) -> Vec<WriteStatement> {
        vec![session_statement(&SETTLE_AS_GATES_ANSWERED_SQL, session_id)]
    }

    fn fold(&self, _session_id: &SessionId) -> Box<dyn SessionProjectionFold> {
        Box::new(*self)
    }
}

impl SessionProjectionFold for ApprovalsProjection {
    fn apply(
        &mut self,
        envelope: &EventEnvelope,
        event: &SessionEvent,
        statements: &mut Vec<WriteStatement>,
    ) -> Result<(), ProjectionContradiction> {
        let occurred_at =
            WireInstant::try_from(envelope.occurred_at.as_str().to_owned()).map_err(|refusal| {
                ProjectionContradiction(format!("the event's instant does not read: {refusal}"))
            })?;
        if let SessionEvent::ApprovalRequested(requested) = event {
            let resource_descriptor = ApprovalResourceDescriptor::try_from(
                &requested.resource_descriptor,
            )
            .map_err(|refusal| {
                ProjectionContradiction(format!(
                    "the ask's resource descriptor does not read: {refusal}"
                ))
            })?;
            statements.push(rewrite_request_statement(&InsertedApprovalRequest {
                approval_request_id: requested.approval_request_id,
                session_id: requested.session_id,
                run_id: requested.run_id,
                requested_by: requested.requested_by.clone(),
                category: requested.category,
                scope: requested.scope.clone(),
                resource_descriptor,
                ask_id: requested.ask_id.clone(),
                created_at: occurred_at,
            }));
        } else if let SessionEvent::ApprovalApproved(resolved) = event {
            push_answer(
                resolved,
                ApprovalDecision::Approved,
                occurred_at,
                statements,
            );
        } else if let SessionEvent::ApprovalRejected(resolved) = event {
            push_answer(
                resolved,
                ApprovalDecision::Rejected,
                occurred_at,
                statements,
            );
        } else if let SessionEvent::ApprovalCanceled(canceled) = event {
            statements.push(settle_pending_statement(
                &canceled.approval_request_id,
                ApprovalSettlement::Canceled,
                &occurred_at,
            ));
        } else if let SessionEvent::ApprovalRuleRemembered(remembered) = event {
            statements.push(remembered_scope_statement(
                &remembered.approval_request_id,
                &remembered.remembered_scope,
            ));
        }
        Ok(())
    }
}

// An answer settles its pending ask and records itself, over the answer a gate-named ask kept.
fn push_answer(
    resolved: &ApprovalResolvedPayload,
    decision: ApprovalDecision,
    resolved_at: WireInstant,
    statements: &mut Vec<WriteStatement>,
) {
    statements.push(settle_pending_statement(
        &resolved.approval_request_id,
        ApprovalSettlement::Decided(decision),
        &resolved_at,
    ));
    statements.push(rewrite_resolution_statement(&InsertedApprovalResolution {
        approval_request_id: resolved.approval_request_id,
        device_id: resolved.device_id.clone(),
        client_resolution_id: resolved.client_resolution_id.clone(),
        decision,
        effective_scope: resolved.effective_scope.clone(),
        asked_scope: resolved.remembered_scope.clone(),
        edited_action: resolved.edited_action.clone(),
        decline_reason: resolved.decline_reason.clone(),
        resolved_at,
    }));
}

// A statement over the session's rows, which any number of them may match.
fn session_statement(sql: &'static LazyLock<String>, session_id: &SessionId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(sql.as_str()),
        bindings: StatementBindings::Positional(vec![Value::Text(
            session_id.text().as_str().to_owned(),
        )]),
        expected_row_count: None,
    }
}
