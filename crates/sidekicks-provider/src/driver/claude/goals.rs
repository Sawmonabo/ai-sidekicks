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
use std::error::Error;
use std::io;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Deserialize;
use serde_json::{Map, Value};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::oneshot;

use self::endings::{
    ClaudeGoalEndings, GOAL_ACTIVE_PREFIX, GoalSetMark, NO_GOAL_SET_PREFIX, is_goal_line,
};
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::delivery::messages::ClaudeMessageFrame;
use crate::driver::claude::delivery::system::{
    ClaudeCommandLifecycle, read_claude_command_lifecycle,
};
use crate::driver::claude::event_normalizer::ClaudeWireFrameKind;
use crate::driver::claude::run::controls::{ClaudeRunControls, cancel_written_message};
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
    /// as it was before, unless no goal was held and the conversation file recorded the goal set
    /// since, which Claude Code then met. Fails as the write or the run's start fails, and when the
    /// read-back is unanswered within the deadline, taken back then, or shows neither goal.
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
        let set_mark = self.endings.set_mark();
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
                    set_mark,
                )
                .await
            }
        }
    }

    // Writes a bare `/goal` onto the session's lead and answers by the goal it prints: `Applied`
    // for `goal_asked` (`None` for no goal), `Degraded` for `goal_before`. No goal shown where none
    // was held before is `Applied` only when the conversation file recorded the goal asked set
    // since `set_mark`, as a goal Claude Code met before the read-back ran. Its start is bounded
    // with its answer, since it waits behind the process that left the set unanswered; one
    // unanswered then is taken back, so Claude Code never runs it later.
    async fn read_back(
        &self,
        session_id: SessionId,
        controls: &ClaudeRunControls,
        goal_asked: Option<&str>,
        goal_before: Option<&str>,
        set_mark: GoalSetMark,
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
                take_back_read_back(session_id, controls, &message_uuid).await;
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
            let was_met_since = goal_before.is_none()
                && goal_asked
                    .is_some_and(|goal| self.endings.was_set_since(session_id, set_mark, goal));
            Ok(if was_met_since {
                DriverGoalResult::Applied {}
            } else {
                degraded()
            })
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

// Takes back a read-back still queued on the session's live process; a take-back that fails is
// logged, since the read-back's own timeout is what the set answers.
async fn take_back_read_back(
    session_id: SessionId,
    controls: &ClaudeRunControls,
    message_uuid: &str,
) {
    let Ok(live) = controls.start.live_session(session_id) else {
        return;
    };
    if let Err(error) = cancel_written_message(&live, message_uuid).await {
        tracing::warn!(
            %session_id,
            error = &error as &(dyn Error + 'static),
            "a goal read-back Claude Code never answered could not be taken back"
        );
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
mod tests;
