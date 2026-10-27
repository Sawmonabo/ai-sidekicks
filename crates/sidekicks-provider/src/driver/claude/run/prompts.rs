//! The messages the daemon wrote to each Claude Code session's live process and has not yet
//! reported taken, and the newest one per session: a conversation cut names the newest as the last
//! one Claude Code saw, and a turn too long for the context window hands it back to the person.
//! The earliest signal that Claude Code took a message reports it once, under the run it was
//! written for; a steer not yet taken keeps its run going into Claude Code's next turn.

use std::collections::{HashMap, HashSet};

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;

// A message written to the live process and not yet reported taken.
struct UnreportedPrompt {
    session_id: SessionId,
    run_id: RunId,
    is_steer: bool,
}

/// Every message written to a live Claude Code process and not yet reported taken, by the uuid
/// its user frame carried, with the uuids each session's process already settled.
#[derive(Default)]
pub(crate) struct ClaudeSentPrompts {
    unreported: HashMap<String, UnreportedPrompt>,
    // Reported or dropped while this process lives, so a later signal for one reports nothing.
    settled_by_session: HashMap<SessionId, HashSet<String>>,
    newest_by_session: HashMap<SessionId, String>,
}

impl ClaudeSentPrompts {
    /// Records a message written to the session's process for `run_id` (a start, a steer, a
    /// resume's kept message or an override sentence) as its newest, not yet reported taken.
    pub(crate) fn record_written(
        &mut self,
        session_id: SessionId,
        run_id: RunId,
        message_uuid: &str,
        is_steer: bool,
    ) {
        self.newest_by_session
            .insert(session_id, message_uuid.to_owned());
        self.unreported.insert(
            message_uuid.to_owned(),
            UnreportedPrompt {
                session_id,
                run_id,
                is_steer,
            },
        );
    }

    /// Claude Code took `message_uuid` (its `started` state, a turn's `user_message_uuids` or its
    /// replayed echo): answers the run to report it under, the run recorded at the write or, for a
    /// message this process never recorded, `lead_run`; `None` once the message is settled.
    pub(crate) fn record_taken(
        &mut self,
        session_id: SessionId,
        message_uuid: &str,
        lead_run: Option<RunId>,
    ) -> Option<RunId> {
        let settled = self.settled_by_session.entry(session_id).or_default();
        if !settled.insert(message_uuid.to_owned()) {
            return None;
        }
        self.unreported
            .remove(message_uuid)
            .map(|prompt| prompt.run_id)
            .or(lead_run)
    }

    /// Claude Code dropped `message_uuid` before taking it (`discarded`, `refused`, `cancelled`,
    /// an interrupt receipt's `cancelled` list): it is settled with no report.
    pub(crate) fn record_dropped(&mut self, session_id: SessionId, message_uuid: &str) {
        self.settled_by_session
            .entry(session_id)
            .or_default()
            .insert(message_uuid.to_owned());
        self.unreported.remove(message_uuid);
    }

    /// Takes back a message Claude Code had not taken, the newest no more, settled with no report;
    /// answers the run it was a steer into, if any.
    pub(crate) fn withdraw(&mut self, session_id: SessionId, message_uuid: &str) -> Option<RunId> {
        if self
            .newest_by_session
            .get(&session_id)
            .is_some_and(|newest| newest == message_uuid)
        {
            self.newest_by_session.remove(&session_id);
        }
        self.settled_by_session
            .entry(session_id)
            .or_default()
            .insert(message_uuid.to_owned());
        self.unreported
            .remove(message_uuid)
            .and_then(|prompt| prompt.is_steer.then_some(prompt.run_id))
    }

    /// Whether a steer written into `run_id`'s turn waits in Claude Code's input, not yet taken.
    pub(crate) fn has_untaken_steer(&self, run_id: RunId) -> bool {
        self.unreported
            .values()
            .any(|prompt| prompt.is_steer && prompt.run_id == run_id)
    }

    /// The newest message sent to the session's process, if one is known.
    pub(crate) fn newest_for(&self, session_id: SessionId) -> Option<&str> {
        self.newest_by_session.get(&session_id).map(String::as_str)
    }

    /// Forgets the session's messages, its process gone; the session's conversation file decides
    /// which of them were taken.
    pub(crate) fn forget_session(&mut self, session_id: SessionId) {
        self.newest_by_session.remove(&session_id);
        self.settled_by_session.remove(&session_id);
        self.unreported
            .retain(|_uuid, prompt| prompt.session_id != session_id);
    }
}

#[cfg(test)]
mod tests {
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;

    use super::ClaudeSentPrompts;

    fn run() -> RunId {
        RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id")
    }

    fn session() -> SessionId {
        SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id")
    }

    // Kills: reporting a second signal for one message, reporting under the lead run instead of
    // the run recorded at the write, and keeping a taken steer as untaken.
    #[test]
    fn the_first_signal_reports_once_under_the_written_run() {
        let session_id = session();
        let (steered_run, lead_run) = (run(), run());
        let mut prompts = ClaudeSentPrompts::default();
        prompts.record_written(session_id, steered_run, "steer", true);
        assert!(prompts.has_untaken_steer(steered_run));

        assert_eq!(
            prompts.record_taken(session_id, "steer", Some(lead_run)),
            Some(steered_run)
        );
        assert!(!prompts.has_untaken_steer(steered_run));
        assert_eq!(
            prompts.record_taken(session_id, "steer", Some(lead_run)),
            None
        );
    }

    // Kills: a dropped message still reported later, and a never-recorded message not falling
    // back to the lead run.
    #[test]
    fn a_dropped_message_reports_nothing_and_an_unrecorded_one_takes_the_lead_run() {
        let session_id = session();
        let (run_id, lead_run) = (run(), run());
        let mut prompts = ClaudeSentPrompts::default();
        prompts.record_written(session_id, run_id, "queued", true);
        prompts.record_dropped(session_id, "queued");
        assert!(!prompts.has_untaken_steer(run_id));
        assert_eq!(
            prompts.record_taken(session_id, "queued", Some(lead_run)),
            None
        );

        // A resume's kept message from before a restart reports on its echo under the lead run.
        assert_eq!(
            prompts.record_taken(session_id, "kept", Some(lead_run)),
            Some(lead_run)
        );
    }

    // Kills: a withdrawn steer still reported or counted untaken, a withdrawn plain message
    // answered as a steer, withdrawing the newest leaving it named newest, and withdrawing an
    // older one clearing the newest.
    #[test]
    fn a_withdrawn_message_is_settled_and_only_a_steer_names_its_run() {
        let session_id = session();
        let (steered_run, lead_run) = (run(), run());
        let mut prompts = ClaudeSentPrompts::default();
        prompts.record_written(session_id, steered_run, "steer", true);
        prompts.record_written(session_id, lead_run, "plain", false);

        assert_eq!(prompts.withdraw(session_id, "steer"), Some(steered_run));
        assert!(!prompts.has_untaken_steer(steered_run));
        assert_eq!(prompts.newest_for(session_id), Some("plain"));
        assert_eq!(
            prompts.record_taken(session_id, "steer", Some(lead_run)),
            None
        );

        assert_eq!(prompts.withdraw(session_id, "plain"), None);
        assert_eq!(prompts.newest_for(session_id), None);
    }

    // Kills: a process end clearing every session's messages, and keeping the ended session's
    // settled uuids, so a message the next process takes under the same uuid reports nothing.
    #[test]
    fn a_process_end_forgets_only_its_own_session() {
        let (ended, live) = (session(), session());
        let (ended_run, live_run, lead_run) = (run(), run(), run());
        let mut prompts = ClaudeSentPrompts::default();
        prompts.record_written(ended, ended_run, "taken", true);
        assert_eq!(
            prompts.record_taken(ended, "taken", Some(lead_run)),
            Some(ended_run)
        );
        prompts.record_written(ended, ended_run, "pending", true);
        prompts.record_written(live, live_run, "queued", true);

        prompts.forget_session(ended);

        assert!(!prompts.has_untaken_steer(ended_run));
        assert_eq!(prompts.newest_for(ended), None);
        assert_eq!(
            prompts.record_taken(ended, "taken", Some(lead_run)),
            Some(lead_run)
        );
        assert!(prompts.has_untaken_steer(live_run));
        assert_eq!(prompts.newest_for(live), Some("queued"));
    }
}
