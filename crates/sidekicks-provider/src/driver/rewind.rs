//! The conversation half of an undo: the provider's own cut of the bound conversation back to
//! before one of the person's messages, in place or on a fork the session restarts on. Files are
//! never the driver's; the daemon's file checkpoints put them back.

use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;
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
}

/// What a rewind did: a cut landed in place or on a fork the session restarts on, or a fallback the
/// driver took instead.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RewindConversationResult {
    /// The cut landed.
    Applied {
        /// The binding the cut's restart runs under when the provider cut by forking, for the
        /// daemon to record once the cut is fenced; `None` for a cut in place.
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
