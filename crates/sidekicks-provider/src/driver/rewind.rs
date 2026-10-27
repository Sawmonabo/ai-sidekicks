//! The conversation half of an undo: the provider's own cut of the bound conversation, in place,
//! back to before one of the person's messages. Files are never the driver's; the daemon's file
//! checkpoints put them back.

use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;

/// Params of `rewind_conversation` (gated on `rollback`). `target_message_id` is the stable id of
/// the person's message the cut lands before: that message and everything after it leave the
/// conversation. The driver maps it to its provider's own anchor, so no position crosses this seam.
/// `binding_id` is the session's live binding, resolved by the daemon at dispatch.
#[derive(Clone, Debug, PartialEq, Eq)]
#[expect(
    clippy::struct_field_names,
    reason = "each member is an id, named for what it identifies"
)]
pub struct RewindConversationParams {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The session's live binding.
    pub(crate) binding_id: RuntimeBindingId,
    /// The person's message the cut lands before.
    pub(crate) target_message_id: String,
}

/// What a rewind did: applied in place, or a fallback the driver took instead.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RewindConversationResult {
    /// The cut landed.
    Applied {
        /// The new binding, when the cut restarted the process on a fork of the conversation (a
        /// provider that cannot cut in place past its last compaction).
        binding_id: Option<RuntimeBindingId>,
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
