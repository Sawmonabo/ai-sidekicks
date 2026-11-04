//! A session goal on Claude Code is its own `/goal` command: `/goal <condition>` sets or replaces
//! the goal and `/goal clear` removes it. With no run holding the session's turn the command opens
//! the session's own run; while the lead's run works it is written onto that run at once, Claude
//! Code runs it when that turn ends, and the run carries into it. The goal is applied once Claude
//! Code started the command (`command_lifecycle` `started` under its message's uuid) and answered
//! it: its command output, or a `result` that reports no error. One command waits per session; a
//! second replaces the first, which then reads unanswered.

pub(crate) mod endings;
pub(crate) mod records;

use std::collections::HashMap;
use std::error::Error;
use std::sync::{Mutex, MutexGuard};

use serde::Deserialize;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::oneshot;

use crate::driver::claude::event_normalizer::ClaudeWireFrameKind;
use crate::driver::claude::run::controls::ClaudeRunControls;
use crate::driver::claude::session::errors::{ClaudeSessionError, ClaudeSessionUnavailableReason};
use crate::driver::claude::session::state::LiveClaudeSession;
use crate::driver::claude::session::transport::CLAUDE_REQUEST_DEADLINE;
use crate::driver::contract::error::DriverError;
use crate::driver::session_control::DriverGoalResult;
use crate::lenient_json::{lenient_object, read_lenient};
use crate::outbound_text::{OutboundText, OutboundTextOrigin};

// Bare, as `system/init` lists `slash_commands`.
const CLAUDE_GOAL_COMMAND_NAME: &str = "goal";

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

// What became of a message the session was sent, by the uuid it was sent under.
#[derive(Default, Deserialize)]
struct CommandLifecycleFrame {
    #[serde(default, deserialize_with = "read_lenient")]
    command_uuid: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    state: Option<String>,
}

lenient_object!(ResultFrame, CommandLifecycleFrame);

// The goal command a session waits on: its message's uuid, the signal its start sends, taken once
// Claude Code started it, and its answer.
struct WaitingGoalCommand {
    message_uuid: String,
    started: Option<oneshot::Sender<()>>,
    reply: oneshot::Sender<ClaudeGoalReply>,
}

/// Sends goal commands and reads each one's answer off the session's own stream.
#[derive(Default)]
pub(crate) struct ClaudeGoalCommands {
    waiting_by_session: Mutex<HashMap<SessionId, WaitingGoalCommand>>,
}

impl ClaudeGoalCommands {
    /// Sends `/goal <goal_text>`, or `/goal clear` for `None`: as the session's own run while
    /// nothing holds its turn, written onto the lead's run while that run works, which Claude Code
    /// runs when its turn ends, and after a command's turn is released. Answers `Applied` once
    /// Claude Code started the command and answered it, and `Degraded` when Claude Code dropped
    /// it, reported an error or no answer within the request deadline of its start, a command's
    /// turn outlasted that deadline, or the handshake lists no `goal` command, in which case
    /// nothing is sent; fails as the write or the run's start fails.
    pub(crate) async fn send(
        &self,
        live: &LiveClaudeSession,
        controls: &ClaudeRunControls,
        goal_text: Option<&str>,
    ) -> Result<DriverGoalResult, DriverError> {
        let start = &controls.start;
        let session_id = live.session_id;
        let is_listed = start
            .handshakes
            .held_handshake_for(session_id, &live.provider_session_id)
            .is_some_and(|held| {
                held.invocable_command_names
                    .contains(CLAUDE_GOAL_COMMAND_NAME)
            });
        if !is_listed {
            return Ok(degraded());
        }
        // A command Claude Code runs as a turn of its own holds no run to write the goal onto.
        if start.routes.lead_run_on(session_id).is_none()
            && start.routes.is_turn_held(session_id)
            && !start
                .routes
                .when_turn_released(session_id, CLAUDE_REQUEST_DEADLINE)
                .await
        {
            return Ok(degraded());
        }
        let message_uuid = mint_uuid_v7().to_string();
        let (started_sender, started) = oneshot::channel();
        let (reply_sender, reply) = oneshot::channel();
        // Waiting before the write, since Claude Code may start the command before it returns; a
        // command already waiting reads unanswered once it is replaced.
        self.lock().insert(
            session_id,
            WaitingGoalCommand {
                message_uuid: message_uuid.clone(),
                started: Some(started_sender),
                reply: reply_sender,
            },
        );
        let text = || OutboundText {
            text: format!(
                "/{CLAUDE_GOAL_COMMAND_NAME} {}",
                goal_text.unwrap_or("clear")
            ),
            // The person set the goal, so Claude Code counts it as theirs and runs it.
            origin: OutboundTextOrigin::HumanText,
        };
        // A run that took the turn between the read and the run's start takes the goal instead.
        let written = match controls
            .write_to_lead(session_id, text(), message_uuid.clone())
            .await
        {
            Err(error) if is_turn_in_flight(&error) => {
                controls
                    .write_to_lead(session_id, text(), message_uuid.clone())
                    .await
            }
            written => written,
        };
        if let Err(error) = written {
            let mut waiting_by_session = self.lock();
            if waiting_by_session
                .get(&session_id)
                .is_some_and(|waiting| waiting.message_uuid == message_uuid)
            {
                waiting_by_session.remove(&session_id);
            }
            return Err(error);
        }
        // Written onto the lead's run, the command starts only when that turn ends, so only its
        // answer is bounded. A command dropped, replaced or let go before it started has its
        // answer, or none, waiting already.
        started.await.unwrap_or(());
        Ok(
            match tokio::time::timeout(CLAUDE_REQUEST_DEADLINE, reply).await {
                Ok(Ok(ClaudeGoalReply::Applied)) => DriverGoalResult::Applied {},
                Ok(Ok(ClaudeGoalReply::Refused) | Err(_)) | Err(_) => degraded(),
            },
        )
    }

    /// Reads one frame of a session's own thread for the goal command it waits on: the command's
    /// own `command_lifecycle` starts or drops it, and only a started command takes the command
    /// output or `result` that follows as its answer, so the lead turn's own end answers none.
    pub(crate) fn observe_lead_frame(&self, session_id: SessionId, frame_kind: &str, text: &str) {
        let Some(kind) = ClaudeWireFrameKind::read(frame_kind) else {
            return;
        };
        if kind == ClaudeWireFrameKind::CommandLifecycle {
            self.observe_command_lifecycle(session_id, text);
            return;
        }
        let reply = if kind == ClaudeWireFrameKind::SystemLocalCommandOutput {
            ClaudeGoalReply::Applied
        } else if kind.is_result() {
            let frame = serde_json::from_str::<ResultFrame>(text).unwrap_or_default();
            if frame.is_error == Some(true) {
                ClaudeGoalReply::Refused
            } else {
                ClaudeGoalReply::Applied
            }
        } else {
            return;
        };
        let mut waiting_by_session = self.lock();
        if waiting_by_session
            .get(&session_id)
            .is_some_and(|waiting| waiting.started.is_none())
            && let Some(waiting) = waiting_by_session.remove(&session_id)
        {
            // A command that stopped waiting needs no answer.
            waiting.reply.send(reply).unwrap_or(());
        }
    }

    // Claude Code's `started` for the waiting command lets its answer come; a terminal drop
    // (`discarded`, `refused`, `cancelled`) answers it refused, since the goal was never set.
    fn observe_command_lifecycle(&self, session_id: SessionId, text: &str) {
        let frame = serde_json::from_str::<CommandLifecycleFrame>(text).unwrap_or_default();
        let (Some(command_uuid), Some(state)) = (frame.command_uuid, frame.state) else {
            return;
        };
        let mut waiting_by_session = self.lock();
        let Some(waiting) = waiting_by_session
            .get_mut(&session_id)
            .filter(|waiting| waiting.message_uuid == command_uuid)
        else {
            return;
        };
        match state.as_str() {
            "started" => {
                if let Some(started) = waiting.started.take() {
                    // A command that stopped waiting needs no signal.
                    started.send(()).unwrap_or(());
                }
            }
            "discarded" | "refused" | "cancelled" => {
                if let Some(waiting) = waiting_by_session.remove(&session_id) {
                    waiting.reply.send(ClaudeGoalReply::Refused).unwrap_or(());
                }
            }
            _ => {}
        }
    }

    /// Lets go of a goal command waiting on a session whose process is gone; it reads unanswered.
    pub(crate) fn forget_session(&self, session_id: SessionId) {
        self.lock().remove(&session_id);
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<SessionId, WaitingGoalCommand>> {
        lock(&self.waiting_by_session)
    }
}

fn degraded() -> DriverGoalResult {
    DriverGoalResult::Degraded {
        fallback_action: None,
    }
}

// Whether the run's start was refused because a run or a command holds the session's turn, at the
// start's own check or at its hold under the run engine.
fn is_turn_in_flight(error: &DriverError) -> bool {
    std::iter::successors(Some(error as &(dyn Error + 'static)), |&error| {
        error.source()
    })
    .filter_map(|error| error.downcast_ref::<ClaudeSessionError>())
    .any(|error| {
        matches!(
            error,
            ClaudeSessionError::Unavailable {
                reason: ClaudeSessionUnavailableReason::SessionTurnInFlight,
                ..
            }
        )
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::{Value, json};
    use sidekicks_std::mutex_lock::lock;
    use tokio::task::JoinHandle;

    use super::degraded;
    use crate::driver::claude::session::scripted::{
        SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession, settle,
    };
    use crate::driver::claude::session::transport::declarations::ClaudeHandshakeDeclaration;
    use crate::driver::contract::error::DriverError;
    use crate::driver::session_control::DriverGoalResult;

    // A live session whose handshake lists `/goal`.
    async fn goal_session() -> Arc<ScriptedSession> {
        let session = ScriptedSession::new().await;
        session.start.handshakes.observe_handshake_declaration(
            session.session_id,
            &session.live.provider_session_id,
            ClaudeHandshakeDeclaration {
                slash_commands: vec!["goal".to_owned()],
                ..ClaudeHandshakeDeclaration::default()
            },
        );
        Arc::new(session)
    }

    // Sets the goal `ship it` on the session, in a task of its own.
    fn set_goal(
        session: &Arc<ScriptedSession>,
    ) -> JoinHandle<Result<DriverGoalResult, DriverError>> {
        let session = Arc::clone(session);
        tokio::spawn(async move {
            session
                .parts
                .establishment
                .task_services
                .goals
                .send(&session.live, &session.parts.run_controls, Some("ship it"))
                .await
        })
    }

    // The set's answer, bounded past the request deadline so a set that never answers fails.
    async fn answer(
        setting: JoinHandle<Result<DriverGoalResult, DriverError>>,
    ) -> DriverGoalResult {
        tokio::time::timeout(Duration::from_secs(600), setting)
            .await
            .expect("the set answers")
            .expect("the set's task ends")
            .expect("the goal is written")
    }

    // The uuid of the one user frame written, the goal command unmarked, as the person's own.
    fn written_goal(session: &ScriptedSession) -> String {
        let frames = session.channel.user_frames();
        assert_eq!(frames.len(), 1, "one user frame is written: {frames:?}");
        let frame = &frames[0];
        assert_eq!(frame["message"]["content"], "/goal ship it");
        assert_eq!(frame.get("client_composed"), None);
        frame["uuid"]
            .as_str()
            .expect("the frame carries its uuid")
            .to_owned()
    }

    fn command_lifecycle(command_uuid: &str, state: &str) -> Value {
        json!({
            "type": "command_lifecycle",
            "session_id": SCRIPTED_PROVIDER_SESSION_ID,
            "command_uuid": command_uuid,
            "state": state,
        })
    }

    fn turn_result() -> Value {
        json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "result": "done",
            "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        })
    }

    // Killed by refusing the set while the lead's run holds the turn, by taking the command as
    // started at its write (the lead turn's own `result` would answer it), and by marking the
    // command composed, which keeps Claude Code from running it.
    #[tokio::test(start_paused = true)]
    async fn a_goal_set_while_the_lead_works_is_written_onto_its_run_and_answered_once_started() {
        let session = goal_session().await;
        let run_id = session.hold_lead_turn("lead");
        let setting = set_goal(&session);
        settle().await;
        let message_uuid = written_goal(&session);
        assert!(lock(&session.start.prompts).has_untaken_steer(run_id));

        session.frame(&turn_result());
        settle().await;
        assert!(
            !setting.is_finished(),
            "the lead turn's own end answers no goal"
        );
        session.frame(&command_lifecycle(&message_uuid, "started"));
        session.frame(&json!({
            "type": "system",
            "subtype": "local_command_output",
            "session_id": SCRIPTED_PROVIDER_SESSION_ID,
            "content": "Goal set: ship it",
        }));

        assert_eq!(answer(setting).await, DriverGoalResult::Applied {});
        assert_eq!(session.ports.taken(), [(message_uuid, run_id)]);
    }

    // Killed by ignoring Claude Code's drop of the command: the set would wait for a start that
    // never comes.
    #[tokio::test(start_paused = true)]
    async fn a_goal_claude_code_drops_before_starting_it_is_not_applied() {
        let session = goal_session().await;
        session.hold_lead_turn("lead");
        let setting = set_goal(&session);
        settle().await;
        let message_uuid = written_goal(&session);

        session.frame(&command_lifecycle(&message_uuid, "cancelled"));

        assert_eq!(answer(setting).await, degraded());
    }

    // Killed by taking the command as started before Claude Code started it: the stray `result`
    // would answer it.
    #[tokio::test(start_paused = true)]
    async fn a_goal_set_on_a_free_turn_opens_the_sessions_run_and_is_answered_once_started() {
        let session = goal_session().await;
        let setting = set_goal(&session);
        settle().await;
        let message_uuid = written_goal(&session);
        let run_id = session
            .engine
            .first_daemon_turn_run()
            .expect("the goal opens the session's own run");
        assert_eq!(
            session
                .start
                .routes
                .lead_run_on(session.session_id)
                .map(|lead| lead.run_id),
            Some(run_id)
        );

        session.frame(&turn_result());
        settle().await;
        assert!(
            !setting.is_finished(),
            "a result before the start answers no goal"
        );
        session.frame(&command_lifecycle(&message_uuid, "started"));
        session.frame(&turn_result());

        assert_eq!(answer(setting).await, DriverGoalResult::Applied {});
    }
}
