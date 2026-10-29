//! A session's asks as the card reads them, pending and answered alike, read straight from this
//! machine's approval tables. What the card shows beyond the row, the subject its standing allow
//! names, the provider's own reason and the answers it may offer, is derived here from the ask as
//! it was raised, never stored apart and never read from the log. A session the daemon holds no
//! ask for reads as none.

use rusqlite::Connection;
use sidekicks_contracts::approval::{
    ApprovalDecision, ApprovalListRequest, ApprovalListResponse, ApprovalProjectionRow,
    ApprovalRequestId, ApprovalState, ApprovedDecision, RejectedDecision,
};
use sidekicks_contracts::wire::text::{NonEmptyText, is_ecmascript_whitespace};

use crate::store::{
    ApprovalRequestFilter, ApprovalRequestReader, StoredApprovalRequest, StoredApprovalResolution,
};

/// Why a session's asks could not be read.
#[derive(Debug, thiserror::Error)]
pub enum ApprovalProjectionReadError {
    /// SQLite refused the read, or a stored column does not read as its type.
    #[error("a read of the session's approval requests failed")]
    Database(#[from] rusqlite::Error),
    /// The ask's state and its answer row disagree: an answered state with no answer, an answer on
    /// an unanswered state, or an answer of the other decision.
    #[error("the stored approval request {approval_request_id} is {state} with no answer to match")]
    StateAndAnswerDisagree {
        /// The ask.
        approval_request_id: ApprovalRequestId,
        /// Its stored state.
        state: &'static str,
    },
}

/// The session's asks, oldest first, narrowed by state or category where `request` names it, read
/// on `connection`, a read-only connection inside a read of the daemon's read pool; the store's
/// statement set covers the read. Fails as [`ApprovalProjectionReadError`] says.
pub fn read_approval_projection(
    connection: &Connection,
    request: &ApprovalListRequest,
) -> Result<ApprovalListResponse, ApprovalProjectionReadError> {
    let filter = ApprovalRequestFilter {
        session_id: request.session_id,
        state: request.state,
        category: request.category,
    };
    let approvals = ApprovalRequestReader::new(connection)
        .list_session_requests(&filter)?
        .into_iter()
        .map(projection_row_of)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ApprovalListResponse { approvals })
}

fn projection_row_of(
    stored: StoredApprovalRequest,
) -> Result<ApprovalProjectionRow, ApprovalProjectionReadError> {
    let StoredApprovalRequest {
        approval_request_id: id,
        run_id,
        requested_by,
        category,
        scope,
        resource_descriptor,
        state,
        created_at,
        updated_at,
        standing_allow_offered,
        project_scope_offered,
        resolution,
        session_id: _,
        ask_id: _,
        tool_call_id: _,
    } = stored;
    let reason = resource_descriptor
        .prompt
        .as_ref()
        .and_then(|prompt| reason_of(prompt.as_str()));
    let subject = NonEmptyText::new(resource_descriptor.subject.as_str().to_owned())
        .expect("a descriptor's subject is non-blank text");
    let resource_descriptor = resource_descriptor.to_record();
    let row = match (state, resolution) {
        (ApprovalState::Pending, None) => ApprovalProjectionRow::Pending {
            id,
            run_id,
            requested_by,
            category,
            scope,
            resource_descriptor,
            subject,
            reason,
            standing_allow_offered,
            project_scope_offered,
            created_at,
            updated_at,
            resolved_at: None,
            decision: None,
            device_id: None,
            effective_scope: None,
            remembered_scope: None,
        },
        (ApprovalState::Canceled, None) => ApprovalProjectionRow::Canceled {
            id,
            run_id,
            requested_by,
            category,
            scope,
            resource_descriptor,
            subject,
            reason,
            standing_allow_offered,
            project_scope_offered,
            created_at,
            updated_at,
            resolved_at: None,
            decision: None,
            device_id: None,
            effective_scope: None,
            remembered_scope: None,
        },
        (
            ApprovalState::Approved,
            Some(StoredApprovalResolution {
                decision: ApprovalDecision::Approved,
                device_id,
                effective_scope,
                remembered_scope,
                resolved_at,
                asked_scope: _,
                client_resolution_id: _,
                edited_action: _,
                decline_reason: _,
            }),
        ) => ApprovalProjectionRow::Approved {
            id,
            run_id,
            requested_by,
            category,
            scope,
            resource_descriptor,
            subject,
            reason,
            standing_allow_offered,
            project_scope_offered,
            created_at,
            updated_at,
            resolved_at,
            decision: ApprovedDecision::Value,
            device_id,
            effective_scope,
            remembered_scope,
        },
        (
            ApprovalState::Rejected,
            Some(StoredApprovalResolution {
                decision: ApprovalDecision::Rejected,
                device_id,
                effective_scope,
                remembered_scope,
                resolved_at,
                asked_scope: _,
                client_resolution_id: _,
                edited_action: _,
                decline_reason: _,
            }),
        ) => ApprovalProjectionRow::Rejected {
            id,
            run_id,
            requested_by,
            category,
            scope,
            resource_descriptor,
            subject,
            reason,
            standing_allow_offered,
            project_scope_offered,
            created_at,
            updated_at,
            resolved_at,
            decision: RejectedDecision::Value,
            device_id,
            effective_scope,
            remembered_scope,
        },
        (ApprovalState::Pending | ApprovalState::Canceled, Some(_))
        | (ApprovalState::Approved | ApprovalState::Rejected, Some(_) | None) => {
            return Err(ApprovalProjectionReadError::StateAndAnswerDisagree {
                approval_request_id: id,
                state: state.into(),
            });
        }
    };
    Ok(row)
}

// The provider's own line with its escape sequences and control characters taken out, so it
// cannot move the card's cursor or color it; absent where nothing readable is left.
fn reason_of(prompt: &str) -> Option<NonEmptyText> {
    let without_escapes = console::strip_ansi_codes(prompt);
    let mut readable = String::with_capacity(without_escapes.len());
    let mut is_in_control_run = false;
    // Every control character left once the escapes are gone, a line break among them.
    for character in without_escapes.chars() {
        if character.is_control() {
            if !is_in_control_run {
                readable.push(' ');
            }
            is_in_control_run = true;
        } else {
            readable.push(character);
            is_in_control_run = false;
        }
    }
    NonEmptyText::new(readable.trim_matches(is_ecmascript_whitespace).to_owned())
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_contracts::wire::text::NonEmptyText;

    use super::reason_of;

    #[rstest]
    #[case::osc_ended_by_bel("\u{1b}]0;title\u{7}Allow npm run", Some("Allow npm run"))]
    #[case::csi_color("\u{1b}[31mred\u{1b}[0m text", Some("red text"))]
    #[case::eight_bit_csi("\u{9b}31mred", Some("red"))]
    #[case::nul("a\u{0}b", Some("a b"))]
    #[case::run_of_line_breaks("one\r\n\n\ntwo", Some("one two"))]
    #[case::only_escapes("\u{1b}[31m\u{1b}[0m", None)]
    #[case::escape_and_line_break_only("\u{1b}[1m\n", None)]
    fn a_reason_line_keeps_only_readable_text(#[case] prompt: &str, #[case] reason: Option<&str>) {
        assert_eq!(reason_of(prompt).as_ref().map(NonEmptyText::as_str), reason);
    }
}
