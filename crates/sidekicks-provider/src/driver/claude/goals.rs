//! A session goal on Claude Code is its own `/goal` command: `/goal <condition>` sets or replaces
//! the goal and `/goal clear` removes it. With no run holding the session's turn the command opens
//! the session's own run; while the lead's run works it is written onto that run at once, Claude
//! Code runs it when that turn ends, and the run carries into it. On a session with no live process
//! the command's run opens the session's process first, and the command is written only where that
//! process lists it. The goal is applied once Claude
//! Code started the command (`command_lifecycle` `started` under its message's uuid) and answered
//! it: its command output, or a `result` that reports no error. A command started with no answer
//! in time is settled by a bare `/goal`, which prints the goal Claude Code holds. One command waits
//! per session; a second replaces the first, which then reads unanswered.

pub(crate) mod endings;
pub(crate) mod file;
pub(crate) mod records;

use std::collections::HashMap;
use std::io;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Deserialize;
use serde_json::{Map, Value};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::oneshot;

use self::endings::{ClaudeGoalEndings, GOAL_ACTIVE_PREFIX, NO_GOAL_SET_PREFIX, is_goal_line};
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::delivery::messages::ClaudeMessageFrame;
use crate::driver::claude::delivery::system::{
    ClaudeCommandLifecycle, read_claude_command_lifecycle,
};
use crate::driver::claude::event_normalizer::ClaudeWireFrameKind;
use crate::driver::claude::run::controls::ClaudeRunControls;
use crate::driver::claude::run::start::ClaudeDaemonTurnOpening;
use crate::driver::claude::session::errors::{
    ClaudeSessionUnavailableReason::CommandAbsent, is_unavailable_for,
};
use crate::driver::claude::session::state::LiveClaudeSession;
use crate::driver::claude::session::transport::CLAUDE_REQUEST_DEADLINE;
use crate::driver::contract::error::DriverError;
use crate::driver::error_causes::{RequestUnanswered, provider_failure_refusal};
use crate::driver::session_control::DriverGoalResult;
use crate::lenient_json::{lenient_object, read_lenient};
use crate::outbound_text::{OutboundText, OutboundTextOrigin};

// Bare, as `system/init` lists `slash_commands`.
const CLAUDE_GOAL_COMMAND_NAME: &str = "goal";

// How Claude Code answered one goal command: with the text it printed, where it printed any, or
// refused.
#[derive(Debug)]
enum ClaudeGoalReply {
    Answered { output: Option<String> },
    Refused,
}

#[derive(Default, Deserialize)]
struct ResultFrame {
    #[serde(default, deserialize_with = "read_lenient")]
    is_error: Option<bool>,
    #[serde(default, deserialize_with = "read_lenient")]
    result: Option<String>,
}

#[derive(Default, Deserialize)]
struct LocalCommandOutputFrame {
    #[serde(default, deserialize_with = "read_lenient")]
    content: Option<String>,
}

lenient_object!(ResultFrame, LocalCommandOutputFrame);

// The goal command a session waits on: its message's uuid, the signal its start sends, taken once
// Claude Code started it, and its answer.
struct WaitingGoalCommand {
    message_uuid: String,
    started: Option<oneshot::Sender<()>>,
    reply: oneshot::Sender<ClaudeGoalReply>,
}

/// Sends goal commands and reads each one's answer off the session's own stream.
pub(crate) struct ClaudeGoalCommands {
    waiting_by_session: Mutex<HashMap<SessionId, WaitingGoalCommand>>,
    // Each session's goal as its stream last showed it, which a read-back tells the set's from.
    endings: Arc<ClaudeGoalEndings>,
}

impl ClaudeGoalCommands {
    /// Goal commands whose read-backs tell a set from the goal `endings` held before it.
    pub(crate) fn new(endings: Arc<ClaudeGoalEndings>) -> Self {
        Self {
            waiting_by_session: Mutex::default(),
            endings,
        }
    }

    /// Sends `/goal <goal_text>`, or `/goal clear` for `None`, on `session_id`, whose live process
    /// is `live`: as the session's own run while nothing holds its turn, written onto the lead's
    /// run while that run works, which Claude Code runs when its turn ends, and after a command's
    /// turn is released. With no live process the command's own run opens the session's process and
    /// writes it there. Answers `Applied` once Claude Code started the command and answered it,
    /// and `Degraded` when Claude Code dropped it, reported an error, a command's turn outlasted
    /// the request deadline, or the process's handshake lists no `goal` command, in which case
    /// nothing is sent. A started command with no answer within that deadline is read back with a
    /// bare `/goal`: `Applied` when it shows the goal asked for, `Degraded` when it shows the goal
    /// as it was before. Fails as the write or the run's start fails, and when the read-back is
    /// unanswered within the deadline or shows neither goal.
    pub(crate) async fn send(
        &self,
        session_id: SessionId,
        live: Option<&LiveClaudeSession>,
        controls: &ClaudeRunControls,
        goal_text: Option<&str>,
    ) -> Result<DriverGoalResult, DriverError> {
        let start = &controls.start;
        if let Some(live) = live {
            if !start.lists_command(live, CLAUDE_GOAL_COMMAND_NAME) {
                return Ok(degraded());
            }
            // A command Claude Code runs as a turn of its own holds no run to write the goal onto.
            // The mark is taken before the turn is read, so its release meanwhile still wakes.
            let mark = start.routes.turn_mark(session_id);
            if start.routes.lead_run_on(session_id).is_none()
                && start.routes.is_turn_held(session_id)
                && !start
                    .routes
                    .when_turn_changed_after(session_id, mark, CLAUDE_REQUEST_DEADLINE)
                    .await
            {
                return Ok(degraded());
            }
        }
        // Read before the write, since the command's own line moves it once Claude Code runs it.
        let goal_before = self.endings.active_condition(session_id);
        let message_uuid = mint_uuid_v7().to_string();
        let (started, reply) = self.wait_for(session_id, &message_uuid);
        let text = || OutboundText {
            text: format!(
                "/{CLAUDE_GOAL_COMMAND_NAME} {}",
                goal_text.unwrap_or("clear")
            ),
            // The person set the goal, so Claude Code counts it as theirs and runs it.
            origin: OutboundTextOrigin::HumanText,
        };
        let written = if live.is_some() {
            controls
                .write_to_lead(session_id, text(), message_uuid.clone())
                .await
        } else {
            start
                .start_daemon_turn(
                    session_id,
                    ClaudeDaemonTurnOpening::Command {
                        name: CLAUDE_GOAL_COMMAND_NAME,
                        text: text(),
                        message_id: message_uuid.clone(),
                    },
                )
                .await
                .map(drop)
        };
        if let Err(error) = written {
            self.let_go(session_id, &message_uuid);
            // The process the run opened lists no `goal`, so nothing was written.
            if is_unavailable_for(&error, CommandAbsent) {
                return Ok(degraded());
            }
            return Err(error);
        }
        // Written onto the lead's run, the command starts only when that turn ends, so only its
        // answer is bounded. A command dropped, replaced or let go before it started has its
        // answer, or none, waiting already.
        started.await.unwrap_or(());
        match tokio::time::timeout(CLAUDE_REQUEST_DEADLINE, reply).await {
            Ok(Ok(ClaudeGoalReply::Answered { .. })) => Ok(DriverGoalResult::Applied {}),
            Ok(Ok(ClaudeGoalReply::Refused) | Err(_)) => Ok(degraded()),
            // Claude Code may have set the goal without a word, so the goal it holds decides.
            Err(_elapsed) => {
                self.read_back(
                    session_id,
                    controls,
                    goal_text.map(str::trim),
                    goal_before.as_deref(),
                )
                .await
            }
        }
    }

    // Writes a bare `/goal` onto the session's lead and answers by the goal it prints: `Applied`
    // for `goal_asked` (`None` for no goal), `Degraded` for `goal_before`. Its start is bounded
    // with its answer, since it waits behind the process that left the set unanswered.
    async fn read_back(
        &self,
        session_id: SessionId,
        controls: &ClaudeRunControls,
        goal_asked: Option<&str>,
        goal_before: Option<&str>,
    ) -> Result<DriverGoalResult, DriverError> {
        let message_uuid = mint_uuid_v7().to_string();
        let (started, reply) = self.wait_for(session_id, &message_uuid);
        let text = OutboundText {
            text: format!("/{CLAUDE_GOAL_COMMAND_NAME}"),
            origin: OutboundTextOrigin::HumanText,
        };
        if let Err(error) = controls
            .write_to_lead(session_id, text, message_uuid.clone())
            .await
        {
            self.let_go(session_id, &message_uuid);
            return Err(error);
        }
        let answered = tokio::time::timeout(CLAUDE_REQUEST_DEADLINE, async {
            started.await.unwrap_or(());
            reply.await
        })
        .await;
        let output = match answered {
            Ok(Ok(ClaudeGoalReply::Answered {
                output: Some(output),
            })) => output,
            Ok(answer) => {
                return Err(read_back_failure(
                    "Claude Code answered the goal's read-back with no goal",
                    RefusalCode::ProviderUnavailable,
                    format!("`/goal` was answered {answer:?}"),
                ));
            }
            Err(_elapsed) => {
                self.let_go(session_id, &message_uuid);
                return Err(read_back_failure(
                    "The Claude Code process did not answer the goal's read-back in time",
                    RefusalCode::ProviderTimeout,
                    "`/goal` was not answered within the request deadline".to_owned(),
                ));
            }
        };
        let output = output.trim();
        if shows_goal(output, goal_asked) {
            Ok(DriverGoalResult::Applied {})
        } else if shows_goal(output, goal_before) {
            Ok(degraded())
        } else {
            Err(read_back_failure(
                "Claude Code's goal read-back shows neither the goal set nor the one before it",
                RefusalCode::ProviderUnavailable,
                format!("`/goal` printed {output:?}"),
            ))
        }
    }

    /// Reads one frame of a session's own thread for the goal command it waits on: the command's
    /// own `command_lifecycle` starts or drops it, and only a started command takes the command
    /// output, goal line or `result` that follows as its answer, so the lead turn's own end
    /// answers none.
    pub(crate) fn observe_lead_frame(&self, session_id: SessionId, frame_kind: &str, text: &str) {
        let Some(kind) = ClaudeWireFrameKind::read(frame_kind) else {
            return;
        };
        if kind == ClaudeWireFrameKind::CommandLifecycle {
            self.observe_command_lifecycle(session_id, text);
            return;
        }
        let reply = if kind == ClaudeWireFrameKind::SystemLocalCommandOutput {
            let frame = serde_json::from_str::<LocalCommandOutputFrame>(text).unwrap_or_default();
            ClaudeGoalReply::Answered {
                output: frame.content,
            }
        } else if kind == ClaudeWireFrameKind::Assistant {
            // A command's goal line may come as the lead's own message, as the stream reads it.
            let frame = serde_json::from_str::<ClaudeMessageFrame>(text).ok();
            let Some(line) = frame
                .as_ref()
                .and_then(ClaudeMessageFrame::text)
                .filter(|line| is_goal_line(line))
            else {
                return;
            };
            ClaudeGoalReply::Answered {
                output: Some(line.to_owned()),
            }
        } else if kind.is_result() {
            let frame = serde_json::from_str::<ResultFrame>(text).unwrap_or_default();
            if frame.is_error == Some(true) {
                ClaudeGoalReply::Refused
            } else {
                ClaudeGoalReply::Answered {
                    output: frame.result,
                }
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
    // answers it refused, since the goal was never set.
    fn observe_command_lifecycle(&self, session_id: SessionId, text: &str) {
        let frame = serde_json::from_str::<Map<String, Value>>(text).unwrap_or_default();
        let (command_uuid, is_started) = match read_claude_command_lifecycle(&frame) {
            Some(ClaudeCommandLifecycle::Started { command_uuid }) => (command_uuid, true),
            Some(ClaudeCommandLifecycle::Dropped { command_uuid, .. }) => (command_uuid, false),
            None => return,
        };
        let mut waiting_by_session = self.lock();
        let Some(waiting) = waiting_by_session
            .get_mut(&session_id)
            .filter(|waiting| waiting.message_uuid == command_uuid)
        else {
            return;
        };
        if is_started {
            if let Some(started) = waiting.started.take() {
                // A command that stopped waiting needs no signal.
                started.send(()).unwrap_or(());
            }
        } else if let Some(waiting) = waiting_by_session.remove(&session_id) {
            waiting.reply.send(ClaudeGoalReply::Refused).unwrap_or(());
        }
    }

    /// Lets go of a goal command waiting on a session whose process is gone; it reads unanswered.
    pub(crate) fn forget_session(&self, session_id: SessionId) {
        self.lock().remove(&session_id);
    }

    // Makes `message_uuid` the command the session waits on, answering its start and its answer.
    // Waiting comes before the write, since Claude Code may start the command before it returns;
    // a command already waiting reads unanswered once it is replaced.
    fn wait_for(
        &self,
        session_id: SessionId,
        message_uuid: &str,
    ) -> (oneshot::Receiver<()>, oneshot::Receiver<ClaudeGoalReply>) {
        let (started_sender, started) = oneshot::channel();
        let (reply_sender, reply) = oneshot::channel();
        self.lock().insert(
            session_id,
            WaitingGoalCommand {
                message_uuid: message_uuid.to_owned(),
                started: Some(started_sender),
                reply: reply_sender,
            },
        );
        (started, reply)
    }

    // Stops waiting on `message_uuid`, where the session still waits on it.
    fn let_go(&self, session_id: SessionId, message_uuid: &str) {
        let mut waiting_by_session = self.lock();
        if waiting_by_session
            .get(&session_id)
            .is_some_and(|waiting| waiting.message_uuid == message_uuid)
        {
            waiting_by_session.remove(&session_id);
        }
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

// Whether a bare `/goal`'s `output` shows `goal`: `No goal set…` for none, else
// `Goal active: <condition> (<checks>)`, the checks `not yet evaluated` or `<n> turn(s)`, and the
// last check's reason on a line of its own after it.
fn shows_goal(output: &str, goal: Option<&str>) -> bool {
    let Some(condition) = goal else {
        return output.starts_with(NO_GOAL_SET_PREFIX);
    };
    let Some(checks) = output
        .strip_prefix(GOAL_ACTIVE_PREFIX)
        .and_then(|rest| rest.strip_prefix(condition))
        .and_then(|rest| rest.strip_prefix(" ("))
    else {
        return false;
    };
    let checks = checks
        .split_once('\n')
        .map_or(checks, |(line, _reason)| line);
    let Some(checks) = checks.strip_suffix(')') else {
        return false;
    };
    checks == "not yet evaluated"
        || checks
            .strip_suffix(" turns")
            .or_else(|| checks.strip_suffix(" turn"))
            .is_some_and(|count| {
                !count.is_empty() && count.bytes().all(|byte| byte.is_ascii_digit())
            })
}

// A set whose read-back did not settle it: the set may stand in Claude Code, as `message` says.
fn read_back_failure(message: &str, code: RefusalCode, detail: String) -> DriverError {
    DriverError::from(RequestUnanswered {
        refusal: provider_failure_refusal(
            &DESCRIPTOR.provider_id(),
            message,
            code,
            io::Error::other(detail),
        ),
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::{Value, json};
    use sidekicks_std::mutex_lock::lock;
    use tokio::task::JoinHandle;

    use futures::FutureExt;

    use super::degraded;
    use crate::driver::claude::session::scripted::channel::ScriptedChannel;
    use crate::driver::claude::session::scripted::driver::{ScriptedDriver, create_params};
    use crate::driver::claude::session::scripted::{
        SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession, hand_scripted_frame, settle,
    };
    use crate::driver::claude::session::transport::CLAUDE_REQUEST_DEADLINE;
    use crate::driver::claude::session::transport::declarations::{
        ClaudeHandshakeDeclaration, ClaudeInitializeDeclaration, ClaudeOfferedModel,
    };
    use crate::driver::contract::error::DriverError;
    use crate::driver::session_control::{DriverGoalResult, SetSessionGoalParams};
    use crate::driver::test_registry::new_session_id;

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
                .send(
                    session.session_id,
                    Some(&session.live),
                    &session.parts.run_controls,
                    Some("ship it"),
                )
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
        result("done")
    }

    fn result(text: &str) -> Value {
        json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "result": text,
            "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        })
    }

    fn local_command_output(content: &str) -> Value {
        json!({
            "type": "system",
            "subtype": "local_command_output",
            "session_id": SCRIPTED_PROVIDER_SESSION_ID,
            "content": content,
        })
    }

    // Sets `ship it` while the lead works and lets Claude Code start it, give no answer within
    // the request deadline, then start the bare `/goal` written after it; answers the set's task.
    async fn set_goal_unanswered(
        session: &Arc<ScriptedSession>,
    ) -> JoinHandle<Result<DriverGoalResult, DriverError>> {
        session.hold_lead_turn("lead");
        let setting = set_goal(session);
        settle().await;
        let message_uuid = written_goal(session);
        session.frame(&command_lifecycle(&message_uuid, "started"));
        tokio::time::sleep(CLAUDE_REQUEST_DEADLINE + Duration::from_secs(1)).await;
        let frames = session.channel.user_frames();
        assert_eq!(frames.len(), 2, "the goal is read back: {frames:?}");
        assert_eq!(frames[1]["message"]["content"], "/goal");
        let read_back_uuid = frames[1]["uuid"]
            .as_str()
            .expect("the read-back carries its uuid");
        session.frame(&command_lifecycle(read_back_uuid, "started"));
        setting
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
        session.frame(&local_command_output("Goal set: ship it"));

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

    // Killed by answering `Degraded` on every set left unanswered: the read-back shows the goal
    // set.
    #[tokio::test(start_paused = true)]
    async fn an_unanswered_goal_the_read_back_shows_set_is_applied() {
        let session = goal_session().await;
        let setting = set_goal_unanswered(&session).await;

        session.frame(&local_command_output(
            "Goal active: ship it (not yet evaluated)",
        ));

        assert_eq!(answer(setting).await, DriverGoalResult::Applied {});
    }

    // Killed by taking the goal before the set as none, and by answering `Applied` on any
    // read-back showing a goal active: the read-back shows the goal the set would have replaced.
    #[tokio::test(start_paused = true)]
    async fn an_unanswered_goal_the_read_back_shows_as_before_is_not_applied() {
        let session = goal_session().await;
        session
            .parts
            .establishment
            .task_services
            .goal_endings
            .seed(session.session_id, Some("keep going".to_owned()));
        let setting = set_goal_unanswered(&session).await;

        session.frame(&local_command_output(
            "Goal active: keep going (2 turns)\nLast check: the tests still fail",
        ));

        assert_eq!(answer(setting).await, degraded());
    }

    // Killed by answering `Degraded` on a read-back that shows neither goal: Claude Code's answer
    // names no goal, so the set may stand and fails instead.
    #[tokio::test(start_paused = true)]
    async fn an_unanswered_goal_whose_read_back_shows_neither_goal_fails() {
        let session = goal_session().await;
        let setting = set_goal_unanswered(&session).await;

        session.frame(&result("Unknown command: /goal"));

        let answered = tokio::time::timeout(Duration::from_secs(600), setting)
            .await
            .expect("the set answers")
            .expect("the set's task ends");
        assert!(
            matches!(answered, Err(DriverError::Unanswered(_))),
            "{answered:?}"
        );
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

    // A goal sent with no live process goes as its own command run, which refuses a process whose
    // handshake lists no `goal`: nothing is written and the goal is not applied. Killed by
    // dropping the command check, which writes the frame and leaves the set waiting.
    #[tokio::test(start_paused = true)]
    async fn a_goal_the_opened_process_does_not_list_is_not_applied_and_writes_nothing() {
        let session = ScriptedSession::new().await;
        session.start.handshakes.observe_handshake_declaration(
            session.session_id,
            &session.live.provider_session_id,
            ClaudeHandshakeDeclaration {
                slash_commands: vec!["compact".to_owned()],
                ..ClaudeHandshakeDeclaration::default()
            },
        );

        let setting = session.parts.establishment.task_services.goals.send(
            session.session_id,
            None,
            &session.parts.run_controls,
            Some("ship it"),
        );
        let answered = tokio::time::timeout(Duration::from_secs(600), setting)
            .await
            .expect("the set answers")
            .expect("a goal the process does not list is answered, not failed");

        assert_eq!(answered, degraded());
        assert!(session.engine.first_daemon_turn_run().is_some());
        assert!(
            session.channel.user_frames().is_empty(),
            "nothing is written"
        );
    }

    // A set on a session that never ran starts its own run, whose binding brings the process up,
    // and writes `/goal` as that run's opening on the commands the process's `initialize` reply
    // listed, before any `system/init`. Killed by reading the live session first in the daemon
    // turn's start (the set fails `NoLiveSession`), and by the reply's commands not seeded as the
    // process's handshake (the set answers `Degraded` with nothing written).
    #[tokio::test(start_paused = true)]
    async fn a_goal_set_on_a_session_that_never_ran_opens_its_process_and_is_written() {
        let scripted = ScriptedDriver::new();
        scripted
            .starts
            .script_initialize(ClaudeInitializeDeclaration {
                models: vec![ClaudeOfferedModel {
                    value: "opus".to_owned(),
                    resolved_model: None,
                    display_name: None,
                    effort_levels: None,
                }],
                commands: vec!["goal".to_owned()],
                ..ClaudeInitializeDeclaration::default()
            });
        let channel = Arc::new(ScriptedChannel::default());
        scripted.starts.script_session(Arc::clone(&channel));
        let driver = Arc::clone(&scripted.driver);
        scripted
            .ports
            .open_processes_for_daemon_turns(Arc::new(move |session_id| {
                let driver = Arc::clone(&driver);
                async move {
                    driver
                        .create_session(create_params(session_id))
                        .await
                        .expect("the turn's process opens");
                }
                .boxed()
            }));
        let session_id = new_session_id();
        let parts = Arc::clone(
            scripted
                .driver
                .composed_parts()
                .expect("the pieces are composed"),
        );
        assert!(parts.run_start.slots.live_session(session_id).is_none());

        let driver = Arc::clone(&scripted.driver);
        let setting = tokio::spawn(async move {
            driver
                .set_session_goal(SetSessionGoalParams::new(session_id, "ship it".to_owned()))
                .await
        });
        // The process comes up on threads outside the paused clock, so the write is waited for.
        let opened_by = std::time::Instant::now() + Duration::from_secs(10);
        while channel.user_frames().is_empty() && std::time::Instant::now() < opened_by {
            settle().await;
        }
        let frames = channel.user_frames();
        assert_eq!(frames.len(), 1, "only the goal is written: {frames:?}");
        assert_eq!(frames[0]["message"]["content"], "/goal ship it");
        let message_uuid = frames[0]["uuid"]
            .as_str()
            .expect("the frame carries its uuid")
            .to_owned();
        let run_id = scripted
            .engine
            .first_daemon_turn_run()
            .expect("the goal opens the session's own run");
        assert_eq!(
            parts
                .run_start
                .routes
                .lead_run_on(session_id)
                .map(|lead| lead.run_id),
            Some(run_id)
        );

        let listener = scripted
            .starts
            .take_started()
            .pop()
            .expect("the turn's process was started")
            .listener;
        let routes = &parts.run_start.routes;
        hand_scripted_frame(
            &*listener,
            routes,
            session_id,
            &command_lifecycle(&message_uuid, "started"),
        );
        hand_scripted_frame(&*listener, routes, session_id, &turn_result());

        assert_eq!(answer(setting).await, DriverGoalResult::Applied {});
    }
}
