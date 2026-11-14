//! The open held calls of the turns an undo cuts, taken off a live session's stream and each
//! closed stopped before the cut.

use sidekicks_contracts::event::declared_variants::ToolCallEndCause;

use super::rebuilt_opening;
use crate::driver::claude::delivery::mcp_tasks::ClaudeHeldCallEnd;
use crate::driver::claude::delivery::messages::ClaudeToolCallOutcome;
use crate::driver::claude::delivery::stream::{ClaudeDeliveryStream, ClaudeSessionStream};
use crate::port::held_tool_calls::HeldToolCall;

impl ClaudeDeliveryStream {
    /// The stopped end of each of `calls`, with no body: a call `session`'s stream holds or keeps
    /// settled is taken off it whole under its lock, so the ending Claude Code reports after the
    /// stop closes nothing again, and a call a resume rebuilt and still awaits is forgotten there
    /// too; any other call, and every call where no stream is open, is rebuilt from the log.
    pub(crate) fn take_cut_held_calls(
        session: Option<&ClaudeSessionStream>,
        calls: Vec<HeldToolCall>,
    ) -> Vec<ClaudeHeldCallEnd> {
        let mut readings = session.map(ClaudeSessionStream::lock);
        calls
            .into_iter()
            .map(|call| {
                let taken = readings.as_mut().and_then(|readings| {
                    let task_id = call.task_id.as_str();
                    readings.restored_calls.confirm(task_id);
                    readings.tool_server_tasks.take_named(task_id)
                });
                let opened = taken.map_or_else(|| rebuilt_opening(&call), |held| held.opened);
                ClaudeHeldCallEnd {
                    tool_use_id: call.tool_call_id.into_string(),
                    opened,
                    outcome: ClaudeToolCallOutcome::Failed {
                        end_cause: Some(ToolCallEndCause::Stopped),
                    },
                    text: None,
                    notification: None,
                }
            })
            .collect()
    }
}
