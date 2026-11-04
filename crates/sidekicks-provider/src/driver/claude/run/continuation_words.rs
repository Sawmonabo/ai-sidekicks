//! The words a Claude lead's continue owes once the daemon's restart cut its pause: Claude Code's
//! own continuation text, sent as the lead's first user message, so the lead picks up its cut work
//! as Claude Code itself resumes a conversation.

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::wire::id::mint_uuid_v7;

use crate::driver::claude::run::controls::ClaudeRunControls;
use crate::driver::claude::session::state::LiveClaudeSession;
use crate::driver::contract::error::DriverError;
use crate::outbound_text::{OutboundText, OutboundTextOrigin};

/// Claude Code's own continuation text, the message it sends a resumed conversation by default.
pub(crate) const CLAUDE_CONTINUATION_TEXT: &str = "Continue from where you left off.";

impl ClaudeRunControls {
    /// Writes Claude Code's continuation words to `run_id` on `live` as the daemon's own message,
    /// never drawn as the person's. Fails as the write fails.
    pub(super) async fn write_continuation_words(
        &self,
        live: &LiveClaudeSession,
        run_id: RunId,
    ) -> Result<(), DriverError> {
        let words = OutboundText {
            text: CLAUDE_CONTINUATION_TEXT.to_owned(),
            origin: OutboundTextOrigin::SystemNarration,
        };
        self.write_message(
            live,
            run_id,
            &words,
            mint_uuid_v7().to_string(),
            Vec::new(),
            false,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::CLAUDE_CONTINUATION_TEXT;
    use crate::driver::claude::session::scripted::ScriptedSession;
    use crate::driver::run_control::ResumeRunParams;

    // A continue the restart's cut owes its continuation sends Claude Code's words first, even with
    // no message waiting. Killed by ignoring the flag (no user message written).
    #[tokio::test]
    async fn a_continue_owed_its_continuation_sends_claude_codes_words_first() {
        let session = ScriptedSession::new().await;
        let run_id = session.hold_lead_turn("lead");

        session
            .parts
            .run_controls
            .resume_run(ResumeRunParams {
                session_id: session.session_id,
                run_id,
                messages: Vec::new(),
                is_continuation_owed: true,
            })
            .await
            .expect("the lead continues");

        let frames = session.channel.user_frames();
        assert_eq!(frames.len(), 1, "{frames:?}");
        assert_eq!(frames[0]["message"]["content"], CLAUDE_CONTINUATION_TEXT);
    }
}
