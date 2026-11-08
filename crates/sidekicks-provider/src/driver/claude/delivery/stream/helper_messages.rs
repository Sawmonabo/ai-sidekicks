//! A helper's own message frames, which carry no row of the session's: an `assistant` frame's
//! calls are read for the session's running commands and kept for their traces, and its text for
//! the goal, where a goal line of the helper's own draws no goal row; a `user` frame's results
//! close those calls, each traced while `Record traces` is on.

use super::body::ClaudeFrameBody;
use super::{ClaudeDeliveryStream, ClaudeSessionStream};
use crate::driver::claude::delivery::messages::record_claude_traces;
use crate::driver::claude::event_normalizer::ClaudeWireFrameKind;
use crate::driver::claude::goals::endings::GoalEndingInput;
use crate::port::tool_traces::is_recording_tool_traces;

impl ClaudeDeliveryStream {
    /// Takes one frame of `kind`, `frame_kind` on the wire, that the helper `helper_id` wrote, its
    /// `body` parsed once.
    pub(super) async fn take_helper_message(
        &self,
        session: &ClaudeSessionStream,
        helper_id: &str,
        kind: &ClaudeWireFrameKind,
        frame_kind: &str,
        body: ClaudeFrameBody,
    ) {
        let ClaudeFrameBody::Message(mut message) = body else {
            return;
        };
        if *kind == ClaudeWireFrameKind::Assistant {
            {
                let mut readings = session.lock();
                readings.command_tasks.observe_calls(&message);
                readings.helper_tool_calls.observe_calls(
                    &mut message,
                    &session.tool_call_arguments,
                    helper_id,
                );
            }
            session.tool_call_arguments.spill_past_bounds().await;
            if let Some(text) = message.text() {
                self.classify_goal(session, GoalEndingInput::HelperText(text), frame_kind)
                    .await;
            }
        } else if *kind == ClaudeWireFrameKind::User {
            let is_tracing = is_recording_tool_traces(&self.dependencies.tool_traces);
            let traces = session.lock().helper_tool_calls.read_traces(
                &message,
                session.session_id,
                is_tracing,
            );
            record_claude_traces(&self.dependencies.tool_traces, traces).await;
        }
    }
}
