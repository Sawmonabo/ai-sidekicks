//! Words the daemon writes to a session's lead: a steer into the turn running, or the session's
//! own run opened with them while no run holds its turn, tried once more after the turn changes
//! where the start found it held.

use sidekicks_contracts::session::id::SessionId;

use crate::driver::claude::run::controls::ClaudeRunControls;
use crate::driver::claude::run::start::ClaudeDaemonTurnOpening;
use crate::driver::contract::error::DriverError;
use crate::outbound_text::OutboundText;

impl ClaudeRunControls {
    /// Writes `text` under `message_uuid` into the lead's running turn as a steer, or starts the
    /// session's own run with it while no run holds its turn. A start refused because the turn is
    /// held waits, within the request deadline, for the turn's next change and writes once more.
    /// Fails `NoLiveSession`, `SessionTurnInFlight` when the turn does not change in time or is
    /// still held after that one change, and as the write or the start fails.
    pub(crate) async fn write_to_lead(
        &self,
        session_id: SessionId,
        text: OutboundText,
        message_uuid: String,
    ) -> Result<(), DriverError> {
        self.start
            .retry_after_turn_change(session_id, move || {
                self.write_to_lead_once(session_id, text.clone(), message_uuid.clone(), false)
            })
            .await
    }

    /// One try of [`Self::write_to_lead`]: a steer into the turn running, else the session's own
    /// run, which `is_live_only` opens only on a live, awake process, refusing `NoLiveSession`
    /// otherwise. Fails as `write_to_lead` does, with no wait.
    pub(super) async fn write_to_lead_once(
        &self,
        session_id: SessionId,
        text: OutboundText,
        message_uuid: String,
        is_live_only: bool,
    ) -> Result<(), DriverError> {
        let Some(lead) = self.start.routes.lead_run_on(session_id) else {
            let opening = if is_live_only {
                ClaudeDaemonTurnOpening::Narration {
                    text,
                    message_id: message_uuid,
                }
            } else {
                ClaudeDaemonTurnOpening::Text {
                    text,
                    message_id: message_uuid,
                    attachment_blocks: Vec::new(),
                }
            };
            self.start.start_daemon_turn(session_id, opening).await?;
            return Ok(());
        };
        // Written into the turn running, it is a steer and opens no turn of its own.
        let live = self.start.live_session(session_id)?;
        self.write_message(&live, lead.run_id, &text, message_uuid, Vec::new(), true)
            .await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use tokio::task::JoinHandle;

    use crate::driver::claude::run::start::ClaudeDaemonTurnOpening;
    use crate::driver::claude::session::errors::{
        ClaudeSessionUnavailableReason::{NoLiveSession, SessionTurnInFlight},
        is_unavailable_for,
    };
    use crate::driver::claude::session::scripted::{ScriptedSession, settle};
    use crate::driver::contract::error::DriverError;
    use crate::driver::test_registry::new_session_id;
    use crate::outbound_text::{OutboundText, OutboundTextOrigin};

    // Writes to the lead of a session whose last run released its turn and on whose turn the run
    // engine refuses the next `held` daemon turns, in a task of its own, answering the write's
    // task and its message's uuid.
    async fn write_while_held(
        held: usize,
    ) -> (
        Arc<ScriptedSession>,
        JoinHandle<Result<(), DriverError>>,
        String,
    ) {
        let session = Arc::new(ScriptedSession::new().await);
        let last_run = session.hold_lead_turn("lead");
        session.start.routes.unbind_run(last_run);
        session.engine.refuse_next_daemon_turns_held(held);
        let message_uuid = mint_uuid_v7().to_string();
        let writing = {
            let session = Arc::clone(&session);
            let message_uuid = message_uuid.clone();
            tokio::spawn(async move {
                let text = OutboundText {
                    text: "The user stopped `sleep 100`.".to_owned(),
                    origin: OutboundTextOrigin::SystemNarration,
                };
                session
                    .parts
                    .run_controls
                    .write_to_lead(session.session_id, text, message_uuid)
                    .await
            })
        };
        settle().await;
        assert!(
            !writing.is_finished(),
            "a start refused for a held turn waits for the turn to change"
        );
        assert_eq!(session.engine.first_daemon_turn_run(), None);
        (session, writing, message_uuid)
    }

    // Killed by surfacing the first held refusal, by trying again before the turn changed (the
    // second start would open the run before the end is noted), by mapping the engine's held
    // refusal to an internal failure, which the retry does not read as held, and by a wait with no
    // deadline, which leaves a write whose turn never changes unanswered.
    #[tokio::test(start_paused = true)]
    async fn a_write_refused_for_a_held_turn_tries_once_more_after_the_run_end_is_noted() {
        let (session, writing, message_uuid) = write_while_held(1).await;
        session
            .start
            .routes
            .note_run_end_written(session.session_id);
        writing
            .await
            .expect("the write's task ends")
            .expect("the second try opens the session's run");
        assert!(session.engine.first_daemon_turn_run().is_some());
        let frames = session.channel.user_frames();
        assert_eq!(frames.len(), 1, "one user frame is written: {frames:?}");
        assert_eq!(frames[0]["uuid"], message_uuid.as_str());

        let (session, writing, _) = write_while_held(2).await;
        session
            .start
            .routes
            .note_run_end_written(session.session_id);
        let refused = writing
            .await
            .expect("the write's task ends")
            .expect_err("a turn still held after one change refuses the write");
        assert!(is_unavailable_for(&refused, SessionTurnInFlight));
        assert_eq!(session.engine.first_daemon_turn_run(), None);
        assert_eq!(
            session.channel.user_frames(),
            Vec::<serde_json::Value>::new()
        );

        let (session, writing, _) = write_while_held(1).await;
        let unchanged = writing
            .await
            .expect("the write's task ends")
            .expect_err("a turn that never changes refuses the write at the deadline");
        assert!(is_unavailable_for(&unchanged, SessionTurnInFlight));
        assert_eq!(session.engine.first_daemon_turn_run(), None);
    }

    // Killed by answering a refusal of the run's binding, raised inside the run's start for a
    // session closed meanwhile, as an internal fault.
    #[tokio::test(start_paused = true)]
    async fn a_write_whose_binding_is_refused_answers_that_refusal() {
        let session = ScriptedSession::new().await;
        session.ports.refuse_daemon_turn_bindings();
        let text = OutboundText {
            text: "Carry on.".to_owned(),
            origin: OutboundTextOrigin::HumanText,
        };
        let refused = session
            .parts
            .run_controls
            .write_to_lead(session.session_id, text, mint_uuid_v7().to_string())
            .await
            .expect_err("the binding's refusal refuses the write");
        assert!(
            matches!(&refused, DriverError::Refused(refusal)
                if refusal.code == RefusalCode::SessionAlreadyClosed),
            "{refused:?}"
        );
        assert_eq!(
            session.channel.user_frames(),
            Vec::<serde_json::Value>::new()
        );
    }

    // Killed by admitting a narration on a session with no live process, which starts a run and
    // opens a process to tell no one.
    #[tokio::test(start_paused = true)]
    async fn a_narration_with_no_live_process_starts_no_run() {
        let session = ScriptedSession::new().await;
        let opening = ClaudeDaemonTurnOpening::Narration {
            text: OutboundText {
                text: "The user stopped `sleep 100`.".to_owned(),
                origin: OutboundTextOrigin::SystemNarration,
            },
            message_id: mint_uuid_v7().to_string(),
        };
        let refused = session
            .start
            .start_daemon_turn(new_session_id(), opening)
            .await
            .expect_err("a narration with no live process is refused");
        assert!(is_unavailable_for(&refused, NoLiveSession));
        assert_eq!(session.engine.first_daemon_turn_run(), None);
    }
}
