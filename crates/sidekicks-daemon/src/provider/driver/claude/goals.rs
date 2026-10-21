//! A session goal on Claude Code is its own `/goal` command, sent for Claude Code to run as the
//! session's own run: `/goal <condition>` sets or replaces the goal and `/goal clear` removes it.
//! The goal is applied once Claude Code answers the command: its command output, or a `result`
//! that reports no error. One command waits per session; a second replaces the first, which then
//! reads unanswered.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::Deserialize;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use tokio::sync::oneshot;

use crate::provider::driver::claude::handshake_register::ClaudeHandshakeRegister;
use crate::provider::driver::claude::run::start::{ClaudeDaemonTurnOpening, ClaudeRunStart};
use crate::provider::driver::claude::session::state::LiveClaudeSession;
use crate::provider::driver::claude::session::transport::CLAUDE_REQUEST_DEADLINE;
use crate::provider::driver::contract::{DriverError, DriverGoalResult};
use crate::provider::lenient_json::{lenient_object, read_lenient};
use crate::provider::outbound_text::{OutboundText, OutboundTextOrigin};

// Bare, as `system/init` lists `slash_commands`.
const CLAUDE_GOAL_COMMAND_NAME: &str = "goal";

// The frame a local command answers with on the stream.
const CLAUDE_COMMAND_OUTPUT_FRAME_KIND: &str = "system/local_command_output";

// How Claude Code answered one goal command.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ClaudeGoalReply {
    Applied,
    Refused,
}

#[derive(Default, Deserialize)]
struct ResultFrame {
    #[serde(default, deserialize_with = "read_lenient")]
    is_error: Option<bool>,
}

lenient_object!(ResultFrame);

/// Sends goal commands and reads each one's answer off the session's own stream.
#[derive(Default)]
pub(crate) struct ClaudeGoalCommands {
    waiting_by_session: Mutex<HashMap<SessionId, oneshot::Sender<ClaudeGoalReply>>>,
}

impl ClaudeGoalCommands {
    /// Sends `/goal <goal_text>`, or `/goal clear` for `None`, as the session's own run, and
    /// answers once Claude Code answers it: `Applied`, or `Degraded` when it reported an error,
    /// sent no answer within the request deadline, or its handshake lists no `goal` command, in
    /// which case nothing is sent. Fails as the run's start fails, `SessionTurnInFlight` while
    /// another run holds the session's turn.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Claude driver's session goal sends the command through it"
        )
    )]
    pub(crate) async fn send(
        &self,
        live: &LiveClaudeSession,
        handshakes: &ClaudeHandshakeRegister,
        start: &ClaudeRunStart,
        goal_text: Option<&str>,
    ) -> Result<DriverGoalResult, DriverError> {
        let is_listed = handshakes
            .held_handshake_for(live.session_id, &live.provider_session_id)
            .is_some_and(|held| {
                held.invocable_command_names
                    .contains(CLAUDE_GOAL_COMMAND_NAME)
            });
        if !is_listed {
            return Ok(DriverGoalResult::Degraded {
                fallback_action: None,
            });
        }
        let (sender, reply) = oneshot::channel();
        // A command already waiting reads unanswered once its sender is replaced.
        self.lock().insert(live.session_id, sender);
        start
            .start_daemon_turn(
                live.session_id,
                ClaudeDaemonTurnOpening::Text {
                    text: OutboundText {
                        text: format!(
                            "/{CLAUDE_GOAL_COMMAND_NAME} {}",
                            goal_text.unwrap_or("clear")
                        ),
                        // The person set the goal, so Claude Code counts it as theirs.
                        origin: OutboundTextOrigin::HumanText,
                    },
                    message_id: mint_uuid_v7().to_string(),
                    attachment_blocks: Vec::new(),
                },
            )
            .await
            .inspect_err(|_| {
                self.lock().remove(&live.session_id);
            })?;
        Ok(
            match tokio::time::timeout(CLAUDE_REQUEST_DEADLINE, reply).await {
                Ok(Ok(ClaudeGoalReply::Applied)) => DriverGoalResult::Applied {},
                Ok(Ok(ClaudeGoalReply::Refused) | Err(_)) | Err(_) => DriverGoalResult::Degraded {
                    fallback_action: None,
                },
            },
        )
    }

    /// Reads one frame of a session's own thread for the goal command it waits on.
    pub(crate) fn observe_lead_frame(&self, session_id: SessionId, frame_kind: &str, text: &str) {
        let reply = if frame_kind == CLAUDE_COMMAND_OUTPUT_FRAME_KIND {
            ClaudeGoalReply::Applied
        } else if frame_kind.split('/').next() == Some("result") {
            let frame = serde_json::from_str::<ResultFrame>(text).unwrap_or_default();
            if frame.is_error == Some(true) {
                ClaudeGoalReply::Refused
            } else {
                ClaudeGoalReply::Applied
            }
        } else {
            return;
        };
        if let Some(waiting) = self.lock().remove(&session_id) {
            // A command that stopped waiting needs no answer.
            waiting.send(reply).unwrap_or(());
        }
    }

    /// Lets go of a goal command waiting on a session whose process is gone; it reads unanswered.
    pub(crate) fn forget_session(&self, session_id: SessionId) {
        self.lock().remove(&session_id);
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<SessionId, oneshot::Sender<ClaudeGoalReply>>> {
        self.waiting_by_session
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}
