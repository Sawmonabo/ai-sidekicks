//! The tool-server calls a process still held when it ended while the daemon runs on and no
//! successor took its session, each settled by what Claude Code kept of it: a saved ending closes
//! it as it ended, traced with that ending while `Record traces` is on, a record keeps it running
//! for the next process to restore, and a call with neither ended with the process. A helper's
//! held call has no row, so only its saved ending's trace is written.

use std::error::Error;

use super::read_traced_ending;
use crate::driver::claude::delivery::mcp_tasks::restore::ClaudeHeldCallSettle;
use crate::driver::claude::delivery::mcp_tasks::{ClaudeHeldCall, ClaudeHeldCallEnd};
use crate::driver::claude::delivery::messages::ClaudeHelperToolCall;
use crate::driver::claude::delivery::stream::{ClaudeDeliveryStream, ClaudeSessionStream};
use crate::port::tool_traces::{is_recording_tool_traces, record_tool_traces};

/// The tool-server calls a session's process held as it ended, each by its task: the lead's, and
/// its helpers', which carry no row.
pub(crate) struct ClaudeExitHolds {
    /// The lead's held calls.
    pub(crate) tool_server_calls: Vec<(String, ClaudeHeldCall)>,
    /// The helpers' held calls.
    pub(crate) helper_calls: Vec<(String, ClaudeHelperToolCall)>,
}

impl ClaudeDeliveryStream {
    /// Settles the calls in `held`, each by its task, that the session's process held as it
    /// ended: a saved ending gives its close, and its trace while `Record traces` is on, a record
    /// writes nothing and keeps its status line, and neither closes it failed as ended with the
    /// process. What Claude Code keeps is read once; a failed read is logged and every call stays
    /// open, so the next resume or the session's close reads again.
    pub(crate) async fn settle_exit(&self, session: &ClaudeSessionStream, held: ClaudeExitHolds) {
        let ClaudeExitHolds {
            tool_server_calls,
            helper_calls,
        } = held;
        if tool_server_calls.is_empty() && helper_calls.is_empty() {
            return;
        }
        let kept = match session.kept_calls().read().await {
            Ok(kept) => kept,
            Err(error) => {
                tracing::warn!(
                    session_id = %session.session_id,
                    error = &error as &(dyn Error + 'static),
                    "what Claude Code keeps of its background calls could not be read as its \
                     process ended, so its held calls stay open"
                );
                return;
            }
        };
        let is_tracing = is_recording_tool_traces(&self.dependencies.tool_traces);
        let ends = tool_server_calls
            .into_iter()
            .filter_map(|(task_id, held)| {
                let kept_call = kept.call(&held.tool_use_id, &task_id);
                let notification = kept_call
                    .saved_ending()
                    .filter(|_| is_tracing)
                    .and_then(|ending| read_traced_ending(session, ending));
                let (outcome, text) = kept_call.into_end(ClaudeHeldCallSettle::ProcessExit)?;
                Some(ClaudeHeldCallEnd {
                    tool_use_id: held.tool_use_id,
                    opened: held.opened,
                    outcome,
                    text,
                    notification,
                })
            })
            .collect();
        self.close_held_calls(session, ends, "process exit").await;
        if !is_tracing {
            return;
        }
        let traces: Vec<_> = helper_calls
            .into_iter()
            .filter_map(|(task_id, call)| {
                let kept_call = kept.call(call.call_id(), &task_id);
                let result = read_traced_ending(session, kept_call.saved_ending()?)?;
                Some(call.into_trace(session.session_id, result))
            })
            .collect();
        record_tool_traces(&self.dependencies.tool_traces, traces).await;
    }
}
