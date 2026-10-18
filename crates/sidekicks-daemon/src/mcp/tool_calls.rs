//! The MCP tool-call rules every driver shares: the idempotency floor for a discovered tool, and
//! the observation half of the durable task handle, which the task handle recorder stores.
//!
//! - A discovered tool is always `manualReconcileOnly`, never derived from its annotation hints:
//!   MCP requires a client to treat annotations as untrusted.
//! - The `taskId` in a task-augmented call's acceptance is the handle recovery polls instead of
//!   halting.

use futures::future::BoxFuture;
use serde_json::Value;
use sidekicks_contracts::provider::driver::tools::IdempotencyClass;
use strum::IntoStaticStr;

use crate::provider::record_readers::read_non_empty_string;

/// The class of every MCP-discovered tool: equal to a driver's default in value but not in rule.
const MCP_DISCOVERED_TOOL_IDEMPOTENCY_CLASS: IdempotencyClass =
    IdempotencyClass::ManualReconcileOnly;

/// Classifies an MCP-discovered tool: always the floor, whatever its annotations claim.
#[expect(
    dead_code,
    reason = "the drivers' MCP tool surfacing reads it when a driver reports the tools a server \
              offers"
)]
pub(crate) const fn classify_mcp_discovered_tool() -> IdempotencyClass {
    MCP_DISCOVERED_TOOL_IDEMPOTENCY_CLASS
}

/// The identity of one task-augmented MCP dispatch. `command_id` is the client-supplied
/// idempotency key on the dispatch's command receipt row; the server and tool name no stored row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct McpTaskDispatchIdentity {
    /// The dispatch's idempotency key.
    pub(crate) command_id: String,
    /// The tool server the call went to.
    pub(crate) server_name: String,
    /// The tool called.
    pub(crate) tool_name: String,
}

/// Which MCP Tasks protocol a task handle belongs to, stored beside the handle so recovery polls
/// it the way its server answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, IntoStaticStr)]
#[strum(serialize_all = "lowercase")]
pub(crate) enum McpTaskGeneration {
    /// A task on a 2025-11-25 server, whose result `tasks/result` reads.
    V1,
    /// A task on a 2026-07-28 server, whose result `tasks/get` carries inline.
    V2,
}

/// A dispatch whose acceptance carried a receiver-generated task id, ready to be recorded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct McpTaskHandleObservation {
    /// The dispatch the handle belongs to.
    pub(crate) dispatch: McpTaskDispatchIdentity,
    /// The task id the receiver generated.
    pub(crate) mcp_task_id: String,
    /// The protocol of the server that accepted the task.
    pub(crate) mcp_task_generation: McpTaskGeneration,
}

/// Where an observed task handle lands: the task handle recorder, which stores it on the
/// dispatch's command receipt row.
pub(crate) trait McpTaskHandleSink: Send + Sync {
    /// Records `observation`; resolves once it is stored or diagnosed, since a store failure
    /// cannot fail a turn.
    fn record(&self, observation: McpTaskHandleObservation) -> BoxFuture<'_, ()>;
}

/// The `task.taskId` of an untrusted acceptance result; `None` for anything but a non-empty string
/// there, never an invented handle.
pub(crate) fn extract_mcp_task_id(acceptance_result: &Value) -> Option<&str> {
    read_non_empty_string(acceptance_result.get("task")?.as_object()?, "taskId")
}

/// Hands `sink` an observation only when the acceptance carries a handle, with the generation of
/// the server that sent it; otherwise nothing is stored, and after a restart the call stays
/// halted, never run again.
#[expect(
    dead_code,
    reason = "the MCP client hands each task acceptance here with the task handle recorder as the \
              sink"
)]
pub(crate) async fn observe_mcp_task_acceptance(
    sink: &dyn McpTaskHandleSink,
    dispatch: McpTaskDispatchIdentity,
    mcp_task_generation: McpTaskGeneration,
    acceptance_result: &Value,
) {
    let Some(mcp_task_id) = extract_mcp_task_id(acceptance_result) else {
        return;
    };
    sink.record(McpTaskHandleObservation {
        dispatch,
        mcp_task_id: mcp_task_id.to_owned(),
        mcp_task_generation,
    })
    .await;
}
