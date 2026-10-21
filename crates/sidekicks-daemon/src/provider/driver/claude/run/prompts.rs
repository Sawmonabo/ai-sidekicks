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
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Claude driver's run start, steer and stream reader record and report \
                  messages through it"
    )
)]
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
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Claude driver's run start, steer and resume record each write"
        )
    )]
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
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Claude driver's stream reader reports each taken message through it"
        )
    )]
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
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Claude driver's stream reader and interrupt drop messages through it"
        )
    )]
    pub(crate) fn record_dropped(&mut self, session_id: SessionId, message_uuid: &str) {
        self.settled_by_session
            .entry(session_id)
            .or_default()
            .insert(message_uuid.to_owned());
        self.unreported.remove(message_uuid);
    }

    /// Takes back a message Claude Code had not taken, the newest no more, settled with no report;
    /// answers the run it was a steer into, if any.
    #[expect(
        dead_code,
        reason = "the Claude driver's steer withdrawal takes a written steer back through it"
    )]
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
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Claude driver's turn settlement carries a run with an untaken steer"
        )
    )]
    pub(crate) fn has_untaken_steer(&self, run_id: RunId) -> bool {
        self.unreported
            .values()
            .any(|prompt| prompt.is_steer && prompt.run_id == run_id)
    }

    /// The newest message sent to the session's process, if one is known.
    #[expect(
        dead_code,
        reason = "the Claude driver's conversation cut and context overflow read it"
    )]
    pub(crate) fn newest_for(&self, session_id: SessionId) -> Option<&str> {
        self.newest_by_session.get(&session_id).map(String::as_str)
    }

    /// Forgets the session's messages, its process gone or its conversation cut; the session's
    /// conversation file decides which of them were taken.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Claude driver's process end and conversation cut clear a session"
        )
    )]
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

    use super::ClaudeSentPrompts;
    use crate::uuid_v7::mint_uuid_v7;

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

    // Kills: a dropped message still reported later, a never-recorded message not falling back
    // to the lead run, and a process end leaving its messages behind.
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

        prompts.record_written(session_id, run_id, "pending", true);
        prompts.forget_session(session_id);
        assert!(!prompts.has_untaken_steer(run_id));
        assert_eq!(
            prompts.record_taken(session_id, "pending", Some(lead_run)),
            Some(lead_run)
        );
    }
}
