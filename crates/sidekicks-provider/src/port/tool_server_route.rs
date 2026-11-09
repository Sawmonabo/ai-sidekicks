//! Where a provider reaches the daemon's tool servers for one spawn: the address and headers of
//! each server's entry, which the daemon's tool-server front opens with a secret of the spawn's
//! own and keeps admitted while the spawn holds it.

use std::fmt;
use std::str::FromStr;

use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use uuid::Uuid;

use crate::driver::callback_tool::CallbackToolDispatcher;

/// Which live conversation of a session a spawn runs, so that two at once each keep an entry of
/// their own: the session's own conversation is keyed by the session's id whichever spawn runs it,
/// so a later spawn of it replaces the earlier one's entry, and one that runs beside another by an
/// id of its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ToolServerConversation(Uuid);

impl ToolServerConversation {
    /// The session's own conversation.
    pub fn of_session(session_id: SessionId) -> Self {
        Self(session_id.into())
    }

    /// A key of its own, for a conversation that runs beside another of the session's: a copy, or
    /// a spawn whose entry is admitted beside the one it follows until its owner lets that go.
    pub fn mint() -> Self {
        Self(mint_uuid_v7())
    }
}

impl fmt::Display for ToolServerConversation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.hyphenated().fmt(formatter)
    }
}

impl FromStr for ToolServerConversation {
    type Err = uuid::Error;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        Uuid::parse_str(text).map(Self)
    }
}

/// One spawn as the daemon's tool servers admit it: the session and conversation it runs, its
/// provider, and the dispatcher bound to its own callback-tool installation.
pub struct ToolServerSpawn {
    /// The session.
    pub session_id: SessionId,
    /// The conversation of the session the spawn runs.
    pub conversation: ToolServerConversation,
    /// The provider the spawn runs.
    pub provider: ProviderId,
    /// Answers the spawn's tool calls.
    pub dispatcher: CallbackToolDispatcher,
}

/// Why a spawn's entry could not be opened: its secret could not be minted.
#[derive(Debug, thiserror::Error)]
#[error("the spawn's tool-server secret could not be minted")]
pub struct ToolServerSecretError(#[source] pub getrandom::Error);

/// One server's entry as a spawn's configuration carries it. Its headers hold the spawn's secret,
/// so it is written only into that configuration, never logged.
pub struct ToolServerRouteEntry {
    /// The server's name on the route.
    pub server_name: String,
    /// The address the provider reaches the server at, which holds no secret.
    pub url: String,
    /// The headers every request to the server carries, the secret's among them.
    pub http_headers: Vec<(String, String)>,
}

/// The entries one spawn opened, admitted until this is dropped.
pub struct OpenedToolServerRoute {
    /// Each server's entry.
    entries: Vec<ToolServerRouteEntry>,
    /// Keeps the entries admitted.
    _hold: Box<dyn Send + Sync>,
}

impl OpenedToolServerRoute {
    /// The opened `entries`, admitted while `hold` is kept.
    pub fn new(entries: Vec<ToolServerRouteEntry>, hold: Box<dyn Send + Sync>) -> Self {
        Self {
            entries,
            _hold: hold,
        }
    }

    /// The entry of `server_name`, when the spawn opened one.
    pub fn entry(&self, server_name: &str) -> Option<&ToolServerRouteEntry> {
        self.entries
            .iter()
            .find(|entry| entry.server_name == server_name)
    }
}

/// The daemon's tool servers at an address, registered through a `PortRegistration`. Until it is
/// registered, a session starts with no daemon tool server entry.
pub trait ToolServerRoute: Send + Sync {
    /// Opens `spawn`'s entry on each of `server_names`, each under a secret derived from the
    /// daemon's key for its address, so a later start of the daemon makes the same secret again,
    /// and replaces any earlier spawn's entry of the same conversation there.
    fn open(&self, spawn: ToolServerSpawn, server_names: &[&str]) -> OpenedToolServerRoute;

    /// Opens `spawn`'s entries as [`Self::open`] does, for a conversation the provider already
    /// runs under an address an earlier start of the daemon gave it: while the hold is kept, a
    /// request at any other conversation's address of the session with no live entry is answered
    /// by this spawn when it presents the secret the daemon's key derives for that address.
    fn adopt(&self, spawn: ToolServerSpawn, server_names: &[&str]) -> OpenedToolServerRoute;
}
