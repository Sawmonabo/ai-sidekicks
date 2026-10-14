//! The newest message the daemon sent each Claude Code session: a conversation cut names it as the
//! last one Claude Code saw, and a turn too long for the context window hands it back to the
//! person. With it, each run's steers Claude Code has not yet replayed as taken: Claude Code starts
//! its next turn with a message a turn ended without taking, so the run those steers went to goes
//! on into it.

use std::collections::{HashMap, HashSet};

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;

// One run's steers Claude Code has not replayed, and the session they were written to.
struct UntakenSteers {
    session_id: SessionId,
    message_uuids: HashSet<String>,
}

/// The newest message sent to each session's live process, by the uuid its user frame carried,
/// and each run's steers not yet taken.
#[derive(Default)]
pub(crate) struct ClaudeSentPrompts {
    newest_by_session: HashMap<SessionId, String>,
    untaken_steers_by_run: HashMap<RunId, UntakenSteers>,
}

impl ClaudeSentPrompts {
    /// Records a message written to the session's process as its newest.
    pub(crate) fn record_sent(&mut self, session_id: &SessionId, message_uuid: &str) {
        self.newest_by_session
            .insert(session_id.clone(), message_uuid.to_owned());
    }

    /// Records a steer written into `run_id`'s turn as its newest message, not yet taken.
    pub(crate) fn record_steer(
        &mut self,
        session_id: &SessionId,
        run_id: &RunId,
        message_uuid: &str,
    ) {
        self.record_sent(session_id, message_uuid);
        self.untaken_steers_by_run
            .entry(run_id.clone())
            .or_insert_with(|| UntakenSteers {
                session_id: session_id.clone(),
                message_uuids: HashSet::new(),
            })
            .message_uuids
            .insert(message_uuid.to_owned());
    }

    /// Claude Code replayed `message_uuid`: it took that message off its input.
    pub(crate) fn record_taken(&mut self, message_uuid: &str) {
        for untaken in self.untaken_steers_by_run.values_mut() {
            untaken.message_uuids.remove(message_uuid);
        }
    }

    /// Whether a steer written into `run_id`'s turn waits in Claude Code's input, not yet taken.
    pub(crate) fn has_untaken_steer(&self, run_id: &RunId) -> bool {
        self.untaken_steers_by_run
            .get(run_id)
            .is_some_and(|untaken| !untaken.message_uuids.is_empty())
    }

    /// Forgets a message taken back before Claude Code read it, the newest no more, and answers
    /// the run it was a steer into, if any.
    pub(crate) fn forget_sent(
        &mut self,
        session_id: &SessionId,
        message_uuid: &str,
    ) -> Option<RunId> {
        if self
            .newest_by_session
            .get(session_id)
            .is_some_and(|newest| newest == message_uuid)
        {
            self.newest_by_session.remove(session_id);
        }
        self.untaken_steers_by_run
            .iter_mut()
            .find_map(|(run_id, untaken)| {
                untaken
                    .message_uuids
                    .remove(message_uuid)
                    .then(|| run_id.clone())
            })
    }

    /// The newest message sent to the session's process, if one is known.
    pub(crate) fn newest_for(&self, session_id: &SessionId) -> Option<&str> {
        self.newest_by_session.get(session_id).map(String::as_str)
    }

    /// Forgets the steers of a run that has ended.
    pub(crate) fn forget_run(&mut self, run_id: &RunId) {
        self.untaken_steers_by_run.remove(run_id);
    }

    /// Forgets the session's newest message and its runs' steers, cut from its conversation or
    /// gone with its process.
    pub(crate) fn forget_session(&mut self, session_id: &SessionId) {
        self.newest_by_session.remove(session_id);
        self.untaken_steers_by_run
            .retain(|_run_id, untaken| untaken.session_id != *session_id);
    }
}
