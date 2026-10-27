//! What each payload the domain crates append gives its envelope: the session it names and who
//! acted.

use sidekicks_contracts::approval::events::{
    ApprovalCanceledPayload, ApprovalDenialOverriddenPayload, ApprovalRequestedPayload,
    ApprovalResolvedPayload, ApprovalReviewerDeniedPayload, ApprovalRuleRememberedPayload,
    ApprovalRuleRevokedPayload,
};
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::repo::mount::{LifecycleActor, WorkspaceLifecyclePayload};
use sidekicks_contracts::run::queue::UserMessageSentPayload;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_contracts::worktree::events::{
    SessionBranchChangedPayload, SessionSweptToCheckoutPayload, WorktreeCreatedPayload,
    WorktreeRetiredPayload,
};
use sidekicks_contracts::worktree::lifecycle::WorktreeLifecyclePayload;

use super::AppendedPayload;

impl AppendedPayload for WorkspaceLifecyclePayload {
    fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    fn actor(&self) -> Option<&LifecycleActor> {
        self.actor.as_ref().and_then(Option::as_ref)
    }
}

impl AppendedPayload for WorktreeLifecyclePayload {
    fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    fn actor(&self) -> Option<&LifecycleActor> {
        self.actor.as_ref().and_then(Option::as_ref)
    }
}

impl AppendedPayload for WorktreeCreatedPayload {
    fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    fn actor(&self) -> Option<&LifecycleActor> {
        self.actor.as_ref().and_then(Option::as_ref)
    }
}

impl AppendedPayload for WorktreeRetiredPayload {
    fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    fn actor(&self) -> Option<&LifecycleActor> {
        self.actor.as_ref().and_then(Option::as_ref)
    }
}

// A session record names no actor: the daemon writes it.
impl AppendedPayload for SessionSweptToCheckoutPayload {
    fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    fn actor(&self) -> Option<&LifecycleActor> {
        None
    }
}

impl AppendedPayload for SessionBranchChangedPayload {
    fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    fn actor(&self) -> Option<&LifecycleActor> {
        None
    }
}

impl AppendedPayload for UserMessageSentPayload {
    fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    fn actor(&self) -> Option<&FreeFormText<EVENT_FIELD_MAX_LEN>> {
        Some(&self.actor)
    }
}

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
