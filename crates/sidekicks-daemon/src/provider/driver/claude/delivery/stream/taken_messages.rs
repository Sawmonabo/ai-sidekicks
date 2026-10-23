//! How Claude Code says it took or dropped a message the daemon wrote: `command_lifecycle`'s
//! `started` reports it taken under the run it was written for, and a terminal drop settles it with
//! no report.

use serde_json::{Map, Value};

use super::{ClaudeDeliveryStream, ClaudeSessionStream};
use crate::provider::record_readers::read_non_empty_string;

impl ClaudeDeliveryStream {
    // A message Claude Code took off its input reports taken under the run it was written for; one
    // it dropped settles with no report.
    pub(super) fn read_command_lifecycle(
        &self,
        session: &ClaudeSessionStream,
        members: &Map<String, Value>,
    ) {
        let (Some(uuid), Some(state)) = (
            read_non_empty_string(members, "command_uuid"),
            read_non_empty_string(members, "state"),
        ) else {
            return;
        };
        match state {
            "started" => self.report_taken(session, uuid),
            // Claude Code's terminal drops: `discarded` for a message still queued as the
            // session ends, `refused` on the same drop path's other arm, and `cancelled` for one
            // an interrupt sent with `cancel_queued` took back.
            "discarded" | "refused" | "cancelled" => {
                session.unmark_now_steer(uuid);
                session
                    .lock_prompts()
                    .record_dropped(session.session_id, uuid);
            }
            _ => {}
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
