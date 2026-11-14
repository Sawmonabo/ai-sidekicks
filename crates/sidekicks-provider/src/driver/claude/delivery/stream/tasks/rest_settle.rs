//! The held calls of a session no process runs, settled from its log and what Claude Code kept.

use sidekicks_contracts::session::id::SessionId;

use super::rebuilt_opening;
use crate::driver::claude::delivery::mcp_tasks::ClaudeHeldCallEnd;
use crate::driver::claude::delivery::mcp_tasks::restore::{ClaudeHeldCallSettle, ClaudeKeptCalls};
use crate::driver::claude::delivery::stream::ClaudeDeliveryStream;
use crate::port::held_tool_calls::HeldToolCall;

impl ClaudeDeliveryStream {
    /// Settles `session_id`'s open calls in `calls`, as its log holds them, by what `kept` holds
    /// of each, read for `settle`; a call the daemon already settled, and one `settle` leaves
    /// running, writes nothing. Each close is appended after its run on the binding the log names,
    /// one at a time in `calls`' order; a refused close is logged as the dispatch logs it.
    pub(crate) async fn settle_held_calls_at_rest(
        &self,
        session_id: SessionId,
        calls: Vec<HeldToolCall>,
        kept: &ClaudeKeptCalls,
        settle: ClaudeHeldCallSettle,
    ) {
        let ends = calls
            .into_iter()
            .filter(|call| call.end_cause.is_none())
            .filter_map(|call| {
                let (outcome, text) = kept
                    .call(call.tool_call_id.as_str(), call.task_id.as_str())
                    .into_end(settle)?;
                Some(ClaudeHeldCallEnd {
                    opened: rebuilt_opening(&call),
                    tool_use_id: call.tool_call_id.into_string(),
                    outcome,
                    text,
                    notification: None,
                })
            })
            .collect();
        self.close_held_calls_directly(session_id, ends).await;
    }
}
