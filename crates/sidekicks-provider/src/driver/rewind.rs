//! The conversation half of an undo: the provider's own cut of the bound conversation back to
//! before one of the person's messages, in place or on a fork the session restarts on. Files are
//! never the driver's; the daemon's file checkpoints put them back.

use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::turn::ProviderTurnId;
use sidekicks_contracts::wire::text::NonEmptyText;

use crate::driver::contract::params_and_results::SpawnedVersionBindingCarriers;

/// Params of `rewind_conversation` (gated on `rollback`). `target_message_id` is the stable id of
/// the person's message the cut lands before: that message and everything after it leave the
/// conversation. The driver maps it to its provider's own anchor, so no position crosses this seam.
/// `binding_id` is the session's live binding, resolved by the daemon at dispatch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RewindConversationParams {
    /// The session.
    pub session_id: SessionId,
    /// The session's live binding.
    pub binding_id: RuntimeBindingId,
    /// The person's message the cut lands before.
    pub target_message_id: String,
    /// The provider's id of the turn that message opened or steered, as the daemon's log recorded
    /// its start, so a driver whose own record lost the message finds its turn by id.
    pub target_turn_id: Option<ProviderTurnId>,
}

/// What a rewind did: a cut landed in place or on a fork the session restarts on, a fallback the
/// driver took instead, or a refusal for a message the provider does not hold.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RewindConversationResult {
    /// The cut landed.
    Applied {
        /// The binding the cut's restart runs under when the provider cut by forking, for the
        /// daemon to record in the cut's own write; `None` for a cut in place.
        fork: Option<ForkedBinding>,
        /// The text of the message the cut removed, for the composer, where the provider returned
        /// it.
        cut_message_text: Option<String>,
    },
    /// The driver was invoked and took a fallback instead.
    Degraded {
        /// The fallback it took.
        fallback_action: Option<String>,
    },
    /// The provider refused the cut because its live conversation holds no such message, and
    /// changed nothing: the message is cut away already, or held in a form the cut does not find.
    TargetNotHeld {
        /// The refusal, as the fallback a `Degraded` names.
        fallback_action: Option<String>,
    },
}

/// When the daemon asks [`read_rewind_target`] of an undo's cut, a fixed fact of the driver: what
/// its own cut answers for a message its provider no longer holds decides it.
///
/// [`read_rewind_target`]: crate::driver::contract::ProviderDriver::read_rewind_target
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RewindTargetAsk {
    /// Before the cut is sent, since a cut sent for a message already cut away would cut again.
    BeforeCut,
    /// Only once the cut came back [`RewindConversationResult::TargetNotHeld`], since the
    /// provider checks every cut against its own live conversation first.
    AfterRefusal,
}

/// Where the bound conversation stands to one of the person's messages, as the provider's own
/// record reads it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RewindTargetPresence {
    /// The conversation still holds the message, or the record does not show it cut.
    Held,
    /// The conversation held the message and a cut took it: it already ends before it.
    CutAway,
}

/// The fork a cut restarted the session on, which the daemon records as a relaunch of the cut
/// binding.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForkedBinding {
    /// The new binding, which the driver minted.
    pub binding_id: RuntimeBindingId,
    /// The conversation the session runs on now: the fork.
    pub resume_handle: NonEmptyText,
    /// The restarted build's version and path, from the one reading its spawn took.
    pub spawned_version: SpawnedVersionBindingCarriers,
}
