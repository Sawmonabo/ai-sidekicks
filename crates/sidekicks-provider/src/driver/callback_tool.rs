//! A callback tool's call as the daemon's `sidekicks` tool route hands it to the callback-tool
//! host, and the host's answer the route returns to the provider, so no call the provider makes
//! goes unanswered.

use std::sync::Arc;

use futures::future::BoxFuture;
use serde_json::{Map, Value};
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_TOOL_NAME_MAX_LEN;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::links::SessionLinkKind;
use sidekicks_contracts::wire::text::FreeFormText;

/// One callback-tool call the provider made, built by the `sidekicks` tool route from arguments it
/// has already checked against the tool's input schema. The host answers an unknown tool `failed`
/// and copies `tool_call_id` onto its answer unchanged, since a tool's start and end pair on it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallbackToolInvocation {
    /// The tool the provider called.
    pub tool_name: FreeFormText<PROVIDER_TOOL_NAME_MAX_LEN>,
    /// The call's arguments as the provider sent them.
    pub arguments: Map<String, Value>,
    /// The provider's id for the call.
    pub tool_call_id: ToolCallId,
    /// The session.
    pub session_id: SessionId,
    /// The run whose turn made the call.
    pub run_id: RunId,
}

/// One link between two sessions that a completed call made, for the daemon to record in the
/// call's activity row's own write.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CallbackToolSessionLink {
    /// The session that acted: for a copy, the new session, so a link need not start at the
    /// caller.
    pub source_session_id: SessionId,
    /// The session it acted on.
    pub target_session_id: SessionId,
    /// What it did: any kind but `related`, which only the link service adds.
    pub kind: SessionLinkKind,
}

/// The daemon's answer to a callback-tool call: only a completed call carries output and the
/// session links it made, and only a denied or failed one an error.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CallbackToolResult {
    /// The tool ran.
    Completed {
        /// What it returned.
        output: Option<Value>,
        /// The links between sessions the call made; empty when it acted on no other session.
        session_links: Vec<CallbackToolSessionLink>,
    },
    /// The approval pipeline refused the call.
    Denied {
        /// Why, for the provider.
        error: Option<String>,
    },
    /// The call could not be run or failed while running.
    Failed {
        /// Why, for the provider.
        error: Option<String>,
    },
}

/// The token-bound dispatcher for one spawn: the `sidekicks` tool route calls it for each
/// callback-tool call and answers the provider with what it returns.
pub type CallbackToolDispatcher =
    Arc<dyn Fn(CallbackToolInvocation) -> BoxFuture<'static, CallbackToolResult> + Send + Sync>;
