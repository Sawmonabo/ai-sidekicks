//! How a session's held tool calls are settled, and the params a driver settles them by.

use serde_json::{Map, Value};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::id::SessionId;

use crate::port::held_tool_calls::HeldToolCall;

/// Asks a driver to settle the tool calls one session held in the background: at rest after a
/// restart or a Stop of the daemon, or the named calls of the turns an undo cuts.
#[derive(Clone, Debug)]
pub struct SettleHeldToolCallsParams {
    /// The session.
    pub session_id: SessionId,
    /// The account the session's leg ran on, read back from its stored spawn record for every
    /// kind of settle.
    pub provider_account_id: ProviderAccountId,
    /// The provider's own handle of the leg's conversation, which keeps the held calls, read back
    /// from the stored spawn record for every kind of settle.
    pub conversation: String,
    /// The provider's own recovery data the leg's binding kept, handed back as stored for every
    /// kind of settle.
    pub runtime_metadata: Map<String, Value>,
    /// How the session's held calls are settled.
    pub settle: HeldCallsSettle,
}

/// How a session's held tool calls are settled.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HeldCallsSettle {
    /// The session is closed: no later resume restores a call, so every one ends.
    Closed,
    /// The daemon restarted: a later resume may restore a call its record keeps, and one kept
    /// nowhere ends with the restart.
    Restarted,
    /// The person stopped the service: a call kept nowhere ends with the Stop, and one its record
    /// keeps waits for the next resume.
    Stopped,
    /// An undo cuts the turns these open calls were made in: each ends stopped while the
    /// session's process lives, so its provider never runs it after the undo.
    Undo {
        /// The open calls of the cut turns, as the session's log holds them.
        calls: Vec<HeldToolCall>,
    },
}
