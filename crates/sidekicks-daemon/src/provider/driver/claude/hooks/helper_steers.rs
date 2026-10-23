//! The person's words for a running helper. Claude Code gives the host no message into a helper,
//! so the words wait here by the helper's agent id and reach it through the daemon's hooks: as
//! context after its next tool call, or as the instruction that keeps it going as it finishes.

use std::collections::HashMap;

use sidekicks_contracts::session::id::SessionId;

use crate::provider::driver::claude::hooks::pause::ClaudeHookAnswer;

/// Each running helper's waiting words, by session and agent id, in the order handed over.
#[derive(Default)]
pub(crate) struct ClaudeHelperSteers {
    waiting: HashMap<(SessionId, String), Vec<String>>,
}

impl ClaudeHelperSteers {
    /// Keeps `words` for the helper `agent_id` until its next hook takes them.
    pub(crate) fn push(&mut self, session_id: SessionId, agent_id: &str, words: String) {
        self.waiting
            .entry((session_id, agent_id.to_owned()))
            .or_default()
            .push(words);
    }

    /// The answer to a helper's post-tool hook: its waiting words as context, or no decision.
    pub(crate) fn answer_after_tool(
        &mut self,
        session_id: SessionId,
        agent_id: Option<&str>,
    ) -> ClaudeHookAnswer {
        match self.take(session_id, agent_id) {
            Some(context) => ClaudeHookAnswer::AddContext {
                hook_event_name: "PostToolUse",
                context,
            },
            None => ClaudeHookAnswer::Pass,
        }
    }

    /// The answer to a helper's stop hook: its waiting words as the instruction that keeps it
    /// going, or no decision, which lets it finish.
    pub(crate) fn answer_at_stop(
        &mut self,
        session_id: SessionId,
        agent_id: Option<&str>,
    ) -> ClaudeHookAnswer {
        match self.take(session_id, agent_id) {
            Some(reason) => ClaudeHookAnswer::Block { reason },
            None => ClaudeHookAnswer::Pass,
        }
    }

    /// Forgets a session whose process is gone; its helpers went with it.
    pub(crate) fn forget_session(&mut self, session_id: SessionId) {
        self.waiting
            .retain(|(waiting_session, _), _| *waiting_session != session_id);
    }

    // The helper's waiting words, joined in the order handed over; the lead has none.
    fn take(&mut self, session_id: SessionId, agent_id: Option<&str>) -> Option<String> {
        let words = self.waiting.remove(&(session_id, agent_id?.to_owned()))?;
        Some(words.join("\n\n"))
    }
}
