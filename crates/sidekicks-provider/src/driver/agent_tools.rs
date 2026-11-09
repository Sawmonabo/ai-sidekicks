//! The facts a driver declares about the daemon's agent tools: how its provider loads them, where it
//! takes their shared rules, how it waits on another session and what it does with a long call.

use serde::{Deserialize, Serialize};
use strum::{IntoStaticStr, VariantArray};

/// How a provider loads the daemon's tools up front rather than behind its own tool search.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentToolLoading {
    /// The provider loads a tool up front when the tool's listing carries `meta_key` in its
    /// `_meta`, set to `true`.
    MarkedOnListing {
        /// The `_meta` key that marks a tool loaded up front.
        meta_key: &'static str,
    },
    /// The provider defers only whole tool-server entries, so the tools loaded up front and the
    /// deferred ones ride separate entries.
    EntryPerLoading,
}

/// Where a provider takes the shared rules of the daemon's tools.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentToolInstructions {
    /// The rules go as the tool server's `instructions` on connection.
    OnConnection,
    /// The rules go as the conversation's developer instructions on start, cold resume and fork.
    OnConversation,
}

/// How a provider waits on another session for a tool call: the call held open until the awaited
/// session finishes or needs the person, or answered at once and its session woken then.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, VariantArray, IntoStaticStr,
)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum AgentToolWait {
    /// The call is held open and answered with the awaited session's result.
    Held,
    /// The call is answered at once, and the waiting session is woken with a new turn.
    AnsweredThenWoken,
}

/// What happens to a call of the daemon's tools that runs past the provider's time limit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentToolLongCall {
    /// The provider moves the call to a background task of its own and delivers the answer itself.
    ProviderBackgrounds,
    /// The daemon answers the call with a task handle of its own and delivers the answer later.
    DaemonHandle,
}
