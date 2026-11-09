//! The open held calls of the turns an undo cuts, stopped on a live session's stream: each is set
//! apart while its task's stop waits, and closed stopped once Claude Code takes the stop, or held
//! again for its own ending when it does not.

use sidekicks_contracts::event::declared_variants::ToolCallEndCause;

use super::rebuilt_opening;
use crate::driver::claude::delivery::mcp_tasks::{ClaudeHeldCallEnd, ClaudeStopOutcome};
use crate::driver::claude::delivery::messages::ClaudeToolCallOutcome;
use crate::driver::claude::delivery::stream::{ClaudeDeliveryStream, ClaudeSessionStream};
use crate::port::held_tool_calls::HeldToolCall;

/// The calls an undo's stops settled: the end of each to close, and the task of each whose stop
/// Claude Code did not take and that still runs.
pub(crate) struct ClaudeCutCallStops {
    /// The end of each call to close.
    pub(crate) ends: Vec<ClaudeHeldCallEnd>,
    /// The task of each call left open.
    pub(crate) not_stopped: Vec<String>,
}

impl ClaudeDeliveryStream {
    /// Begins the stop of each of `calls` on `session`'s stream under its lock: a call it holds or
    /// keeps settled is set apart, so an ending Claude Code reports before the stop answers closes
    /// nothing and is kept for that answer, and a call a resume rebuilt and still awaits is
    /// forgotten there.
    pub(crate) fn begin_cut_held_call_stops(
        session: Option<&ClaudeSessionStream>,
        calls: &[HeldToolCall],
    ) {
        let Some(session) = session else {
            return;
        };
        let mut readings = session.lock();
        for call in calls {
            let task_id = call.task_id.as_str();
            readings.restored_calls.confirm(task_id);
            readings.tool_server_tasks.begin_stop(task_id);
        }
    }

    /// Settles each of `calls` by whether Claude Code took its task's stop, `stops` one per call:
    /// a call whose stop was taken ends stopped with no body, one whose task ended while its stop
    /// waited ends as that ending said, and any other is held on `session`'s stream again, so its
    /// own ending still closes it, its task named not stopped. A call the stream did not hold, and
    /// every call where no stream is open, is rebuilt from the log when its stop was taken.
    pub(crate) fn finish_cut_held_call_stops(
        session: Option<&ClaudeSessionStream>,
        calls: Vec<HeldToolCall>,
        stops: &[bool],
    ) -> ClaudeCutCallStops {
        let mut readings = session.map(ClaudeSessionStream::lock);
        let mut settled = ClaudeCutCallStops {
            ends: Vec::new(),
            not_stopped: Vec::new(),
        };
        for (call, &is_stopped) in calls.into_iter().zip(stops) {
            let outcome = readings
                .as_mut()
                .map_or(ClaudeStopOutcome::NotBegun, |readings| {
                    readings
                        .tool_server_tasks
                        .finish_stop(call.task_id.as_str(), is_stopped)
                });
            match outcome {
                ClaudeStopOutcome::Ended(end) => settled.ends.push(end),
                ClaudeStopOutcome::NotBegun if is_stopped => settled.ends.push(ClaudeHeldCallEnd {
                    opened: rebuilt_opening(&call),
                    tool_use_id: call.tool_call_id.into_string(),
                    outcome: ClaudeToolCallOutcome::Failed {
                        end_cause: Some(ToolCallEndCause::Stopped),
                    },
                    text: None,
                    notification: None,
                }),
                ClaudeStopOutcome::NotBegun | ClaudeStopOutcome::HeldAgain => {
                    settled.not_stopped.push(call.task_id.as_str().to_owned());
                }
            }
        }
        settled
    }
}
