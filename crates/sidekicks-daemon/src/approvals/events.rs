//! The `approval.*` events: what each payload gives its envelope, and which event an answer
//! records. A caller appends one with `SessionEventDraft::new(payload, SessionEvent::…)` and a
//! `SessionEventLinkage` carrying the event's instant and the rows it settles in the same write.
//! Every approval event names no actor: the daemon records it, and the answering device rides the
//! resolution's own payload. A reviewer's block keeps the provider's own record of it whole in its
//! `reviewer_denials` row, written in the block's own write, never as the row's body.

use sidekicks_contracts::approval::ApprovalDecision;
use sidekicks_contracts::approval::events::{
    ApprovalCanceledPayload, ApprovalDenialOverriddenPayload, ApprovalRequestedPayload,
    ApprovalResolvedPayload, ApprovalReviewerDeniedPayload, ApprovalRuleRememberedPayload,
    ApprovalRuleRevokedPayload,
};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::events::session::appender::AppendedPayload;

// Each payload names its session, and the daemon is the actor of every one.
macro_rules! daemon_recorded_payloads {
    ($($payload:ty),+ $(,)?) => {$(
        impl AppendedPayload for $payload {
            fn session_id(&self) -> &SessionId {
                &self.session_id
            }

            fn actor(&self) -> Option<&FreeFormText<EVENT_FIELD_MAX_LEN>> {
                None
            }
        }
    )+};
}

daemon_recorded_payloads!(
    ApprovalRequestedPayload,
    ApprovalResolvedPayload,
    ApprovalCanceledPayload,
    ApprovalRuleRememberedPayload,
    ApprovalRuleRevokedPayload,
    ApprovalReviewerDeniedPayload,
    ApprovalDenialOverriddenPayload,
);

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
