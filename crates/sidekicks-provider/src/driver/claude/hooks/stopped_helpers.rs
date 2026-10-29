//! The helpers stopped alone, at their token limit or refused by the daemon after they started:
//! each one's next tool use is denied with the sentence its reason carries, so it reports what it
//! did and finishes while its lead goes on.

use std::collections::HashMap;

use sidekicks_contracts::session::id::SessionId;

use crate::driver::claude::hooks::pause::ClaudeHookAnswer;
use crate::driver::run_control::HelperStopReason;

/// The helpers stopped alone, by session and agent id, each with why it was stopped.
#[derive(Default)]
pub(crate) struct ClaudeStoppedHelpers {
    stopped: HashMap<(SessionId, String), HelperStopReason>,
}

impl ClaudeStoppedHelpers {
    /// Stops the helper `agent_id` from its next tool use on, for `reason`; a later stop's reason
    /// replaces an earlier one.
    pub(crate) fn stop(&mut self, session_id: SessionId, agent_id: &str, reason: HelperStopReason) {
        self.stopped
            .insert((session_id, agent_id.to_owned()), reason);
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
            .get(&(session_id, agent_id.to_owned()))
            .map(|reason| ClaudeHookAnswer::Deny {
                reason: reason.sentence(),
            })
    }

    /// Forgets a session whose process is gone, its helpers with it.
    pub(crate) fn forget_session(&mut self, session_id: &SessionId) {
        self.stopped
            .retain(|(stopped_session, _), _| stopped_session != session_id);
    }
}
