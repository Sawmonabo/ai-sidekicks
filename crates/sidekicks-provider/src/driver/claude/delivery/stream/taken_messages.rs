//! How Claude Code says it took or dropped a message the daemon wrote: `command_lifecycle`'s
//! `started` reports it taken under the run it was written for, a terminal drop settles it with no
//! report, and a peer message the receiver's policy refused is published as refused.

use serde_json::{Map, Value};

use super::{ClaudeDeliveryStream, ClaudeSessionStream};
use crate::driver::claude::delivery::system::{
    ClaudeCommandDrop, ClaudeCommandLifecycle, read_claude_command_lifecycle,
};
use crate::port::session_message_reading_publisher::SessionMessageReading;

impl ClaudeDeliveryStream {
    // A message Claude Code took off its input reports taken under the run it was written for; one
    // it dropped settles with no report.
    pub(super) fn read_command_lifecycle(
        &self,
        session: &ClaudeSessionStream,
        members: &Map<String, Value>,
    ) {
        match read_claude_command_lifecycle(members) {
            Some(ClaudeCommandLifecycle::Started { command_uuid }) => {
                self.report_taken(session, command_uuid);
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

    pub(super) fn report_taken(&self, session: &ClaudeSessionStream, uuid: &str) {
        let lead = self
            .dependencies
            .routes
            .lead_run_on(session.session_id)
            .map(|lead| lead.run_id);
        let taken_by = session
            .lock_prompts()
            .record_taken(session.session_id, uuid, lead);
        if let Some(run_id) = taken_by {
            (self.dependencies.message_taken)(session.session_id, uuid, run_id);
        }
    }
}
