//! A helper's own message frames, which carry no row of the session's: an `assistant` frame's
//! calls are read for the session's running commands and kept for their traces, and its text for
//! the goal, where a goal line of the helper's own draws no goal row; a `user` frame's results
//! close those calls, each traced while `Record traces` is on. A file-tool call opens and settles
//! as the lead's does.

use super::body::ClaudeFrameBody;
use super::{ClaudeDeliveryStream, ClaudeSessionStream};
use crate::driver::claude::delivery::file_tool_writes::open_file_tool_writes;
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
            let opened_writes = {
                let mut readings = session.lock();
                // Read before the calls' inputs move off the frame.
                let opened_writes = session
                    .file_tool_writes
                    .open_calls(&message, session.session_id);
                readings.command_tasks.observe_calls(&message);
                readings.helper_tool_calls.observe_calls(
                    &mut message,
                    &session.tool_call_arguments,
                    helper_id,
                );
                opened_writes
            };
            open_file_tool_writes(&self.dependencies.file_tool_writes, opened_writes).await;
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
            session
                .file_tool_writes
                .settle_results(&message, session.session_id);
            record_claude_traces(&self.dependencies.tool_traces, traces).await;
        }
    }
}
