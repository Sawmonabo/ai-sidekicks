//! A callback tool's call as a driver hands it to the daemon, and the daemon's answer the driver
//! relays to the provider, so no call the provider makes goes unanswered.

use std::sync::Arc;

use futures::future::BoxFuture;
use serde_json::{Map, Value};
use sidekicks_contracts::command::COMMAND_ID_MAX_LEN;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_TOOL_NAME_MAX_LEN;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;

/// The longest provider correlation id a callback-tool call carries, in code points: the same cap
/// as a command's id.
pub(crate) const PROVIDER_TOOL_CALL_ID_MAX_LEN: usize = COMMAND_ID_MAX_LEN;

/// One callback-tool call the provider made, built by the driver from provider output; the bounds
/// its text members hold are the only checks made here. The daemon answers an unknown tool
/// `failed` and checks `arguments` against the tool's input schema before any approval, and
/// copies `tool_call_id` onto its answer unchanged, since a tool's start and end pair on it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CallbackToolInvocation {
    /// The tool the provider called.
    pub(crate) tool_name: FreeFormText<PROVIDER_TOOL_NAME_MAX_LEN>,
    /// The call's arguments as the provider sent them.
    pub(crate) arguments: Map<String, Value>,
    /// The provider's id for the call.
    pub(crate) tool_call_id: FreeFormText<PROVIDER_TOOL_CALL_ID_MAX_LEN>,
    /// The session.
    pub(crate) session_id: SessionId,
    /// The run whose turn made the call.
    pub(crate) run_id: RunId,
}

/// The daemon's answer to a callback-tool call: only a completed call carries output, and only a
/// denied or failed one an error.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CallbackToolResult {
    /// The tool ran.
    Completed {
        /// What it returned.
        output: Option<Value>,
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

/// The dispatcher the daemon hands a driver at spawn: the driver calls it for each callback-tool
/// call and answers the provider with what it returns.
pub(crate) type CallbackToolDispatcher =
    Arc<dyn Fn(CallbackToolInvocation) -> BoxFuture<'static, CallbackToolResult> + Send + Sync>;
