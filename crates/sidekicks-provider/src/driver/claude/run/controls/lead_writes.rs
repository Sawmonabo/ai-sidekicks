//! Words the daemon writes to a session's lead: a steer into the turn running, or the session's
//! own run opened with them while no run holds its turn.

use sidekicks_contracts::session::id::SessionId;

use crate::driver::claude::run::controls::ClaudeRunControls;
use crate::driver::claude::run::start::ClaudeDaemonTurnOpening;
use crate::driver::contract::error::DriverError;
use crate::outbound_text::OutboundText;

impl ClaudeRunControls {
    /// Writes `text` under `message_uuid` into the lead's running turn as a steer, or starts the
    /// session's own run with it while no run holds its turn. Fails `NoLiveSession`,
    /// `SessionTurnInFlight` while a command holds the turn, and as the write or the start fails.
    pub(crate) async fn write_to_lead(
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
