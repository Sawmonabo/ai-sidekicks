//! A helper's own message frames, which carry no row of the session's: an `assistant` frame's
//! calls are read for the session's running commands and its text for the goal, where a goal line
//! of the helper's own draws no goal row.

use super::body::ClaudeFrameBody;
use super::{ClaudeDeliveryStream, ClaudeSessionStream};
use crate::driver::claude::event_normalizer::ClaudeWireFrameKind;
use crate::driver::claude::goals::endings::GoalEndingInput;

impl ClaudeDeliveryStream {
    /// Takes one frame of `kind`, `frame_kind` on the wire, that a helper wrote, its `body`
    /// parsed once.
    pub(super) async fn take_helper_message(
        &self,
        session: &ClaudeSessionStream,
        kind: &ClaudeWireFrameKind,
        frame_kind: &str,
        body: ClaudeFrameBody,
    ) {
        if *kind == ClaudeWireFrameKind::Assistant
            && let ClaudeFrameBody::Message(message) = &body
        {
            session.lock().command_tasks.observe_calls(message);
            if let Some(text) = message.text() {
                self.classify_goal(session, GoalEndingInput::HelperText(text), frame_kind)
                    .await;
            }
        }
    }
}
