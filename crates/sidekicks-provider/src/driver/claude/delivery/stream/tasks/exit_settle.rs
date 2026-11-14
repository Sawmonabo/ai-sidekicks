//! The tool-server calls a process still held when it ended, each settled by what Claude Code kept
//! of it while the daemon runs on and no successor took its session, but a call whose task ended
//! while an undo's stop waited, which closes with that ending: a saved ending closes it as
//! it ended, traced with that ending while `Record traces` is on, a record keeps it running for the
//! next process to restore, and a call with neither ended with the process. A helper's held call
//! has no row, so only its saved ending's trace is written. At the daemon's stop the calls stay
//! open for the next start to restore, and only the saved endings' traces are written.

use std::error::Error;

use super::read_traced_ending;
use crate::driver::claude::delivery::mcp_tasks::restore::{ClaudeHeldCallSettle, ClaudeKeptCalls};
use crate::driver::claude::delivery::mcp_tasks::{ClaudeHeldCall, ClaudeHeldCallEnd};
use crate::driver::claude::delivery::messages::{
    ClaudeHelperToolCall, ClaudeKeptTrace, record_claude_traces,
};
use crate::driver::claude::delivery::stream::{ClaudeDeliveryStream, ClaudeSessionStream};
use crate::port::tool_traces::is_recording_tool_traces;

/// The tool-server calls a session's process held as it ended, each by its task: the lead's, and
/// its helpers', which carry no row.
pub(crate) struct ClaudeExitHolds {
    /// The lead's held calls.
    pub(crate) tool_server_calls: Vec<(String, ClaudeHeldCall)>,
    /// The lead's calls whose task ended while an undo's stop of it waited, each with its own
    /// ending.
    pub(crate) ended_during_stop: Vec<(String, ClaudeHeldCallEnd)>,
    /// The helpers' held calls.
    pub(crate) helper_calls: Vec<(String, ClaudeHelperToolCall)>,
}

impl ClaudeExitHolds {
    fn is_empty(&self) -> bool {
        self.tool_server_calls.is_empty()
            && self.ended_during_stop.is_empty()
            && self.helper_calls.is_empty()
    }
}

impl ClaudeDeliveryStream {
    /// Settles the calls in `held`, each by its task, that the session's process held as it
    /// ended: a call whose task ended while an undo's stop waited closes with that ending; for
    /// every other, a saved ending gives its close, and its trace while `Record traces` is on, a
    /// record writes nothing and keeps its status line, and neither closes it failed as ended with
    /// the process. What Claude Code keeps is read once; a failed read is logged and every call
    /// still running stays open, so the next resume or the session's close reads again.
    pub(crate) async fn settle_exit(&self, session: &ClaudeSessionStream, held: ClaudeExitHolds) {
        if held.is_empty() {
            return;
        }
        let ended = held
            .ended_during_stop
            .into_iter()
            .map(|(_, end)| end)
            .collect();
        self.close_held_calls(session, ended, "process exit").await;
        let Some(kept) = read_kept_at_end(session).await else {
            return;
        };
        let is_tracing = is_recording_tool_traces(&self.dependencies.tool_traces);
        let ends = held
            .tool_server_calls
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
        if is_tracing {
            let traces = helper_traces(session, &kept, held.helper_calls);
            record_claude_traces(&self.dependencies.tool_traces, traces).await;
        }
    }

    /// Traces each call in `held` that Claude Code saved an ending for, the lead's and the
    /// helpers', as the daemon's stop ends the session's process, while `Record traces` is on;
    /// no call is closed, so the next start restores each. A failed read of what Claude Code
    /// keeps is logged and traces nothing.
    pub(crate) async fn trace_stop_endings(
        &self,
        session: &ClaudeSessionStream,
        held: ClaudeExitHolds,
    ) {
        if held.is_empty() || !is_recording_tool_traces(&self.dependencies.tool_traces) {
            return;
        }
        let Some(kept) = read_kept_at_end(session).await else {
            return;
        };
        let calls = held
            .tool_server_calls
            .into_iter()
            .map(|(task_id, held)| (task_id, held.tool_use_id, held.opened))
            .chain(
                held.ended_during_stop
                    .into_iter()
                    .map(|(task_id, end)| (task_id, end.tool_use_id, end.opened)),
            );
        let mut traces: Vec<ClaudeKeptTrace> = calls
            .filter_map(|(task_id, tool_use_id, mut opened)| {
                let kept_call = kept.call(&tool_use_id, &task_id);
                let result = read_traced_ending(session, kept_call.saved_ending()?)?;
                opened.take_trace(session.session_id, &tool_use_id, || result)
            })
            .collect();
        traces.extend(helper_traces(session, &kept, held.helper_calls));
        record_claude_traces(&self.dependencies.tool_traces, traces).await;
    }
}

// What Claude Code keeps of the session's background calls as its process ends; `None`, logged,
// for a failed read.
async fn read_kept_at_end(session: &ClaudeSessionStream) -> Option<ClaudeKeptCalls> {
    session
        .kept_calls()
        .read()
        .await
        .inspect_err(|error| {
            tracing::warn!(
                session_id = %session.session_id,
                error = error as &(dyn Error + 'static),
                "what Claude Code keeps of its background calls could not be read as its process \
                 ended, so its held calls stay open and untraced"
            );
        })
        .ok()
}

// The trace of each helper call in `calls` that Claude Code saved an ending for, with that ending.
fn helper_traces(
    session: &ClaudeSessionStream,
    kept: &ClaudeKeptCalls,
    calls: Vec<(String, ClaudeHelperToolCall)>,
) -> Vec<ClaudeKeptTrace> {
    calls
        .into_iter()
        .filter_map(|(task_id, call)| {
            let kept_call = kept.call(call.call_id(), &task_id);
            let result = read_traced_ending(session, kept_call.saved_ending()?)?;
            Some(call.into_trace(session.session_id, result))
        })
        .collect()
}
