//! The `approval.*` events: which event an answer records. A caller appends one with
//! `SessionEventDraft::new(payload, SessionEvent::…)` and a `SessionEventLinkage` carrying the
//! event's instant and the rows it settles in the same write.

use sidekicks_contracts::approval::ApprovalDecision;
use sidekicks_contracts::approval::events::ApprovalResolvedPayload;
use sidekicks_contracts::event::session::SessionEvent;

/// The event an answer records, for `SessionEventDraft::new` with the answer's payload:
/// `approval.approved` for an approval, `approval.rejected` for a decline. Never fails.
pub(crate) fn resolved_event(
    decision: ApprovalDecision,
) -> fn(ApprovalResolvedPayload) -> SessionEvent {
    match decision {
        ApprovalDecision::Approved => SessionEvent::ApprovalApproved,
        ApprovalDecision::Rejected => SessionEvent::ApprovalRejected,
    }
}
