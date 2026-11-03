//! The helpers stopped at their token limit, refused by the daemon after they started, or stopped
//! from the console with every other agent: each one's next tool use is denied with the sentence
//! its reason carries, so it reports what it did and finishes. A stop that is not final clears as
//! the helper's new own run starts.

use std::collections::HashMap;

use sidekicks_contracts::session::id::SessionId;

use crate::driver::claude::hooks::pause::ClaudeHookAnswer;
use crate::driver::run_control::HelperStopReason;

/// The stopped helpers, by session and agent id, each with why it was stopped.
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
    /// The helper stays stopped until its stop clears, so a tool use after the denial is denied
    /// too.
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

    /// Clears the helper `agent_id`'s stop when it is not final, as the helper's new own run
    /// starts; a stop-all stop stays.
    pub(crate) fn release(&mut self, session_id: SessionId, agent_id: &str) {
        let helper = (session_id, agent_id.to_owned());
        let is_kept = match self.stopped.get(&helper) {
            Some(HelperStopReason::TokenLimit | HelperStopReason::SetupRefused { .. }) => false,
            Some(HelperStopReason::StopAll) | None => true,
        };
        if !is_kept {
            self.stopped.remove(&helper);
        }
    }

    /// Why the helper `agent_id` is stopped, `None` while it is not.
    pub(crate) fn stop_reason_of(
        &self,
        session_id: SessionId,
        agent_id: &str,
    ) -> Option<&HelperStopReason> {
        self.stopped.get(&(session_id, agent_id.to_owned()))
    }

    /// Forgets a session whose process is gone, its helpers with it.
    pub(crate) fn forget_session(&mut self, session_id: &SessionId) {
        self.stopped
            .retain(|(stopped_session, _), _| stopped_session != session_id);
    }
}
