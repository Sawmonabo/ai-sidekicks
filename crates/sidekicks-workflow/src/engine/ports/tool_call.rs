//! The port a workflow step calls a tool server's tool through, on the session's own connection
//! to that server; the MCP client implements it.

use futures::future::BoxFuture;
use serde_json::{Map, Value};
use sidekicks_contracts::mcp::server::{McpServerName, McpToolName};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use tokio_util::sync::CancellationToken;

use crate::engine::ports::PortError;

/// Calls a tool server's tool for a step and records the call's receipt.
pub trait StepToolCaller: Send + Sync {
    /// Calls `call`'s tool and returns how the call ended. Fails when the call was not sent, when
    /// its end was not recorded, or when the call ended without an end the client could read, its
    /// receipt recorded failed or unknown.
    fn call_tool(&self, call: StepToolCall) -> BoxFuture<'_, Result<StepToolCallEnd, PortError>>;
}

/// One tool call a step makes.
#[derive(Debug)]
pub struct StepToolCall {
    /// The session whose connection to the server the call goes over.
    pub session_id: SessionId,
    /// The run the call belongs to, whose questions a task's server asks.
    pub run_id: RunId,
    /// The server's name in the session.
    pub server: McpServerName,
    /// The tool's name on that server.
    pub tool: McpToolName,
    /// The tool's arguments.
    pub arguments: Option<Map<String, Value>>,
    /// The call's receipt key, unique per call: a reused one fails the call before anything is
    /// sent.
    pub command_id: String,
    /// The step's cancel, which ends the call.
    pub cancel: CancellationToken,
}

/// How a step's tool call ended.
#[derive(Clone, Debug, PartialEq)]
pub enum StepToolCallEnd {
    /// The server's `CallToolResult`, as it sent it; reading its `isError` is the step's job.
    Answered {
        /// The result.
        result: Map<String, Value>,
    },
    /// The server's task failed with this JSON-RPC error.
    Failed {
        /// The error object.
        error: Map<String, Value>,
    },
    /// The call was canceled.
    Canceled,
    /// The call's outcome is unknown: the session closed under the call, or the server lost its
    /// task or the input it waited on.
    Unknown,
    /// The daemon is stopping: nothing was written, any receipt stays in flight, and the step
    /// drops its work.
    Stopping,
}
