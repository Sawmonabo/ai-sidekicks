//! Words the daemon writes to a session's lead: a steer into the turn running, or the session's
//! own run opened with them while no run holds its turn, tried once more after the turn changes
//! where the start found it held.

use sidekicks_contracts::session::id::SessionId;

use crate::driver::claude::run::controls::ClaudeRunControls;
use crate::driver::claude::run::start::ClaudeDaemonTurnOpening;
use crate::driver::claude::session::errors::{
    ClaudeSessionUnavailableReason::SessionTurnInFlight, is_unavailable_for,
};
use crate::driver::contract::error::DriverError;
use crate::outbound_text::OutboundText;

impl ClaudeRunControls {
    /// Writes `text` under `message_uuid` into the lead's running turn as a steer, or starts the
    /// session's own run with it while no run holds its turn. A start refused because the turn is
    /// held, by a command or by a run whose end is not yet written, waits for the turn's next
    /// change and writes once more. Fails `NoLiveSession`, `SessionTurnInFlight` when the turn is
    /// still held after that one change, and as the write or the start fails.
    pub(crate) async fn write_to_lead(
        &self,
        session_id: SessionId,
        text: OutboundText,
        message_uuid: String,
    ) -> Result<(), DriverError> {
        // Taken before the first try, so a change while it runs still wakes the wait.
        let mark = self.start.routes.turn_mark(session_id);
        match self
            .write_to_lead_once(session_id, text.clone(), message_uuid.clone())
            .await
        {
            Err(error) if is_unavailable_for(&error, SessionTurnInFlight) => {
                self.start
                    .routes
                    .when_turn_changed_after(session_id, mark)
                    .await;
                self.write_to_lead_once(session_id, text, message_uuid)
                    .await
            }
            written => written,
        }
    }

    // One try of `write_to_lead`: a steer into the turn running, else the session's own run.
    async fn write_to_lead_once(
        &self,
        session_id: SessionId,
        text: OutboundText,
        message_uuid: String,
    ) -> Result<(), DriverError> {
        let Some(lead) = self.start.routes.lead_run_on(session_id) else {
            self.start
                .start_daemon_turn(
                    session_id,
                    ClaudeDaemonTurnOpening::Text {
                        text,
                        message_id: message_uuid,
                        attachment_blocks: Vec::new(),
                    },
                )
                .await?;
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

    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use tokio::task::JoinHandle;

    use crate::driver::claude::session::errors::{
        ClaudeSessionUnavailableReason::SessionTurnInFlight, is_unavailable_for,
    };
    use crate::driver::claude::session::scripted::{ScriptedSession, settle};
    use crate::driver::contract::error::DriverError;
    use crate::outbound_text::{OutboundText, OutboundTextOrigin};

    // Writes to the lead of a session on whose turn the run engine refuses the next `held`
    // daemon turns, in a task of its own, answering the write's task and its message's uuid.
    async fn write_while_held(
        held: usize,
    ) -> (
        Arc<ScriptedSession>,
        JoinHandle<Result<(), DriverError>>,
        String,
    ) {
        let session = Arc::new(ScriptedSession::new().await);
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
    // second start would open the run before the end is noted), and by mapping the engine's held
    // refusal to an internal failure, which the retry does not read as held.
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
    }
}
