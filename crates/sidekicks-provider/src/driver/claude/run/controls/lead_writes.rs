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
    use std::sync::atomic::{AtomicUsize, Ordering};

    use futures::FutureExt;

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

    // A narration on a session whose process exited, which the queue has not yet forgotten, is
    // refused before any run exists. Killed by skipping the start's own live read, so the run
    // starts, binds on the process the queue still holds and fails as a fault.
    #[tokio::test(start_paused = true)]
    async fn a_narration_after_its_process_exited_starts_no_run() {
        let session = ScriptedSession::new().await;
        session.exit();
        settle().await;
        assert!(
            session
                .start
                .slots
                .live_session(session.session_id)
                .is_none(),
            "the driver no longer reports the process live"
        );
        let opening = ClaudeDaemonTurnOpening::Narration {
            text: OutboundText {
                text: "The user stopped `sleep 100`.".to_owned(),
                origin: OutboundTextOrigin::SystemNarration,
            },
            message_id: mint_uuid_v7().to_string(),
        };
        let refused = session
            .start
            .start_daemon_turn(session.session_id, opening)
            .await
            .expect_err("a narration with no live process is refused");
        assert!(is_unavailable_for(&refused, NoLiveSession), "{refused:?}");
        assert_eq!(session.engine.first_daemon_turn_run(), None);
    }

    // A narration whose process exits after the start read it live, before its run's binding,
    // opens no process and is refused as having none. Killed by binding a narration with a process
    // opened where none is (the opener runs), and by answering the binding's missing process as a
    // fault.
    #[tokio::test(start_paused = true)]
    async fn a_narration_whose_process_exits_before_its_binding_opens_none() {
        let session = Arc::new(ScriptedSession::new().await);
        let opened = Arc::new(AtomicUsize::new(0));
        let opens = Arc::clone(&opened);
        session
            .ports
            .open_processes_for_daemon_turns(Arc::new(move |_session_id| {
                opens.fetch_add(1, Ordering::SeqCst);
                async {}.boxed()
            }));
        let release = session.engine.hold_next_daemon_turn_start();
        let starting = {
            let session = Arc::clone(&session);
            tokio::spawn(async move {
                let opening = ClaudeDaemonTurnOpening::Narration {
                    text: OutboundText {
                        text: "The user stopped `sleep 100`.".to_owned(),
                        origin: OutboundTextOrigin::SystemNarration,
                    },
                    message_id: mint_uuid_v7().to_string(),
                };
                session
                    .start
                    .start_daemon_turn(session.session_id, opening)
                    .await
            })
        };
        settle().await;
        assert!(
            session.engine.first_daemon_turn_run().is_some(),
            "the start read the process live"
        );

        session.exit();
        session.ports.let_processes_go();
        release.send(()).expect("the start waits on its hold");
        let refused = starting
            .await
            .expect("the start's task ends")
            .expect_err("a narration whose process exited is refused");

        assert!(is_unavailable_for(&refused, NoLiveSession), "{refused:?}");
        assert_eq!(opened.load(Ordering::SeqCst), 0);
    }
}
