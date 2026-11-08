//! The daemon's tool-trace bucket as the drivers reach it: one record per tool call, its arguments
//! and result as the provider gave them, kept while `Record traces` is on.

use std::sync::Arc;

use futures::future::BoxFuture;
use serde::Serialize;
use serde_json::value::RawValue;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::port_registration::PortRegistration;

/// One tool call as the provider gave it: its own arguments and result body, a superset of what
/// the session's events carry.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolTrace {
    /// The session the call ran in.
    pub session_id: SessionId,
    /// The provider that made the call.
    pub provider: ProviderId,
    /// The provider's own id for the call.
    pub tool_call_id: String,
    /// The tool's name in the provider's spelling.
    pub tool_name: String,
    /// The arguments as the provider sent them, word for word.
    pub arguments: Box<RawValue>,
    /// The result body as the provider sent it, word for word.
    pub result: Box<RawValue>,
}

/// Where the drivers' tool traces are recorded.
pub trait ToolTraces: Send + Sync {
    /// Whether `Record traces` is on now. Asked before a trace is built, so nothing is built or
    /// kept for one while it is off.
    fn is_recording(&self) -> bool;

    /// Records `trace`, resolving once it is written; while `Record traces` is off it writes
    /// nothing.
    fn record(&self, trace: ToolTrace) -> BoxFuture<'_, ()>;
}

/// Whether `tool_traces` is registered and recording now, so a driver keeps what a trace needs.
pub(crate) fn is_recording_tool_traces(
    tool_traces: &PortRegistration<Arc<dyn ToolTraces>>,
) -> bool {
    tool_traces
        .port()
        .is_some_and(|tool_traces| tool_traces.is_recording())
}

/// Records each of `traces` in order through `tool_traces` once it is registered, resolving once
/// each is written or, with `Record traces` off, dropped.
pub(crate) async fn record_tool_traces(
    tool_traces: &PortRegistration<Arc<dyn ToolTraces>>,
    traces: impl IntoIterator<Item = ToolTrace>,
) {
    let Some(tool_traces) = tool_traces.port() else {
        return;
    };
    for trace in traces {
        tool_traces.record(trace).await;
    }
}
