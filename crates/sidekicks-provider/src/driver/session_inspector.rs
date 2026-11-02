//! What the daemon hands a driver to read a session's inspector sections, its memory and its
//! hooks, and to apply the session's `Auto memory` switch.

use std::path::PathBuf;

use serde_json::{Map, Value};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::id::SessionId;

use crate::driver::session_control::{SessionAccountPin, SessionConversation};

/// The session a driver reads its memory and hooks for, or applies the `Auto memory` switch to,
/// with the account, folder and stored switch those reads depend on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InspectedSession {
    /// The session.
    pub session_id: SessionId,
    /// The account the session's latest binding on this provider ran on, else the account its next
    /// run would be admitted against.
    pub provider_account_id: ProviderAccountId,
    /// Whether the session moves with the provider's current account or stays on its own, which
    /// picks the home a session with no binding yet would open in.
    pub account_pin: SessionAccountPin,
    /// The provider's own recovery data the session's latest binding on this provider kept, as
    /// stored; `None` before its first binding.
    pub runtime_metadata: Option<Map<String, Value>>,
    /// The session's working folder, absolute.
    pub working_folder: PathBuf,
    /// The session's stored `Auto memory` switch; `None` when it was never set.
    pub auto_memory: Option<bool>,
}

/// What the daemon hands a driver to turn the session's `Auto memory` switch on or off.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdateAutoMemoryParams {
    /// The session the switch belongs to.
    pub session: InspectedSession,
    /// Whether the switch is turned on.
    pub is_enabled: bool,
    /// Every conversation the session opened on this provider, newest first, the ones it left
    /// included, each with the recovery data that names the home holding it.
    pub conversations: Vec<SessionConversation>,
}
