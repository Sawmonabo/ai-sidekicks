//! The helpers stopped at their token limit: each one's next tool use is denied with the reason it
//! reads, so it reports what it did and finishes while its lead goes on.

use std::collections::HashSet;

use sidekicks_contracts::session::id::SessionId;

use crate::driver::claude::hooks::pause::ClaudeHookAnswer;
use crate::driver::run_control::HELPER_TOKEN_LIMIT_REASON;

/// The helpers past their token limit, by session and agent id.
#[derive(Default)]
pub(crate) struct ClaudeHelperTokenLimits {
    stopped: HashSet<(SessionId, String)>,
}

impl ClaudeHelperTokenLimits {
    /// Stops the helper `agent_id` from its next tool use on.
    pub(crate) fn stop(&mut self, session_id: SessionId, agent_id: &str) {
        self.stopped.insert((session_id, agent_id.to_owned()));
    }

    /// The denial a stopped helper's tool use gets, `None` for any other helper and the lead.
    /// The helper stays stopped, so a tool use after the denial is denied too.
    pub(crate) fn answer_before_tool(
        &self,
        session_id: SessionId,
        agent_id: Option<&str>,
    ) -> Option<ClaudeHookAnswer> {
        let agent_id = agent_id?;
        self.stopped
            .contains(&(session_id, agent_id.to_owned()))
            .then(|| ClaudeHookAnswer::Deny {
                reason: HELPER_TOKEN_LIMIT_REASON.to_owned(),
            })
    }

    /// Forgets a session whose process is gone, its helpers with it.
    pub(crate) fn forget_session(&mut self, session_id: &SessionId) {
        self.stopped
            .retain(|(stopped_session, _)| stopped_session != session_id);
    }
}
