//! How Claude Code says it took or dropped a message the daemon wrote: `command_lifecycle`'s
//! `started` reports it taken under the run it was written for, a terminal drop settles it with no
//! report, and a peer message the receiver's policy refused is published as refused. A message
//! this process wrote lands where Claude Code took it: in its run's open turn, unless it opened
//! that turn, else kept for that run's next turn.

use serde_json::{Map, Value};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;

use super::{ClaudeDeliveryStream, ClaudeSessionStream};
use crate::driver::claude::delivery::run_readings::ClaudeTakenMessage;
use crate::driver::claude::delivery::system::{
    ClaudeCommandDrop, ClaudeCommandLifecycle, read_claude_command_lifecycle,
};
use crate::port::session_message_reading_publisher::SessionMessageReading;
use crate::run::delivery::InboundDelivery;

impl ClaudeDeliveryStream {
    // A message Claude Code took off its input reports taken under the run it was written for; one
    // it dropped settles with no report.
    pub(super) async fn read_command_lifecycle(
        &self,
        session: &ClaudeSessionStream,
        members: &Map<String, Value>,
    ) {
        match read_claude_command_lifecycle(members) {
            Some(ClaudeCommandLifecycle::Started { command_uuid }) => {
                self.report_taken(session, command_uuid).await;
            }
            Some(ClaudeCommandLifecycle::Dropped {
                command_uuid,
                state,
            }) => {
                session.unmark_now_steer(command_uuid);
                session
                    .lock_prompts()
                    .record_dropped(session.session_id, command_uuid);
                // `refused` also names a peer message the receiver's policy declined.
                if state == ClaudeCommandDrop::Refused
                    && let Some(publisher) = self.dependencies.session_message_readings.port()
                {
                    publisher.publish(SessionMessageReading::Refused {
                        message_id: command_uuid.to_owned(),
                        reason: None,
                        drop_reason: None,
                    });
                }
            }
            None => {}
        }
    }

    // Reports a message taken at the first sign of it, once, after landing it where this process
    // wrote it; a message this process never recorded lands nothing.
    pub(super) async fn report_taken(&self, session: &ClaudeSessionStream, uuid: &str) {
        let lead = self
            .dependencies
            .routes
            .lead_run_on(session.session_id)
            .map(|lead| lead.run_id);
        let taken = session
            .lock_prompts()
            .record_taken(session.session_id, uuid, lead);
        let Some(taken) = taken else {
            return;
        };
        if taken.is_written
            && let Ok(message_id) = QueueItemId::new(uuid)
        {
            self.land_taken(session, taken.run_id, uuid, message_id)
                .await;
        }
        (self.dependencies.message_taken)(session.session_id, uuid, taken.run_id);
    }

    // Lands a message in its run's open, numbered turn unless it opened that turn; with no turn of
    // its run open it waits for the run's next turn.
    async fn land_taken(
        &self,
        session: &ClaudeSessionStream,
        run_id: RunId,
        uuid: &str,
        message_id: QueueItemId,
    ) {
        let landing = {
            let mut readings = session.lock();
            match readings.turn.as_ref().filter(|turn| turn.run_id == run_id) {
                Some(turn) if turn.opening.as_deref() == Some(uuid) => None,
                Some(turn) => turn
                    .turn_number
                    .map(|turn_number| (turn.binding_id.clone(), turn_number)),
                None => {
                    readings
                        .taken_without_turn
                        .push(ClaudeTakenMessage { run_id, message_id });
                    None
                }
            }
        };
        if let Some((binding_id, turn_number)) = landing {
            let steered = InboundDelivery::TurnSteered {
                binding_id,
                turn_number,
                message_id,
            };
            self.send(session, steered, None).await;
        }
    }
}
