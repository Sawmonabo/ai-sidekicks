//! Routes each request a live Claude Code process sends: the daemon's own pause, helper-start,
//! message-target, helper-limit, helper-wake, send and background-work hooks are answered here, the
//! pre-tool hook of a call that changes a file only once its file's copy is kept, that of a command
//! that runs with no wrapper only once its window is open and that of a shell call the wrapper runs
//! once the call is noted, the post-tool hooks of a command with no wrapper close its window, and
//! every other request (tool asks, dialogs, the question hook, a reviewer's block) goes on to the
//! event side, which answers it or leaves it pending at the provider.

pub(crate) mod helper_calls;

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;
use sidekicks_std::error_description::describe_error;

use crate::background_work::{BackgroundWorkForms, refuse_background_work};
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::hooks::callbacks::helper_calls::helper_limit_route;
use crate::driver::claude::hooks::command_capture::{
    ClaudeCommandEnd, ClaudeCommandTarget, ClaudeCommandWindows, read_claude_command_target,
};
use crate::driver::claude::hooks::edit_checkpoint::{keep_copy_then_answer, read_claude_edit};
use crate::driver::claude::hooks::helper_limit::{ClaudeCountedProcess, ClaudeHelperLimit};
use crate::driver::claude::hooks::helper_steers::ClaudeHelperSteers;
use crate::driver::claude::hooks::pause::{
    ClaudeHookAnswer, ClaudePauseAnswer, ClaudeReleasedCallback, ClaudeRunPauses,
};
use crate::driver::claude::hooks::registration::{
    CLAUDE_HELPER_TOOL_NAME, CLAUDE_MESSAGE_TOOL_NAME, ClaudeHookCallback as RegisteredHook,
};
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::claude::session::transport::inbound::{
    ClaudeHookCallback, ClaudeInboundRequestBody, ClaudeInboundRequestEvent,
};
use crate::driver::claude::session::transport::user_message::ClaudeWriteAttempt;
use crate::driver::contract::error::bound_failure_detail;
use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::driver::error_causes::UNSPECIFIED_PROVIDER_FAILURE_DETAIL;
use crate::lenient_json::{lenient_object, read_lenient};
use crate::port::edit_checkpoint::{EditCheckpoint, EditCheckpointRequest};
use crate::process_identity::ProviderProcessIdentity;

/// Where one request a process sent goes.
#[derive(Debug)]
pub(crate) enum ClaudeRequestRoute {
    /// Answer it now.
    Answer {
        /// The request's id.
        request_id: String,
        /// The answer.
        answer: ClaudeHookAnswer,
    },
    /// Leave it unanswered until a continue or a finished helper lets it go.
    Held {
        /// The helper a pause holds, `None` on a hold the helper limit makes.
        helper: Option<ClaudeHeldHelper>,
    },
    /// Answer it with no decision once its call is captured: an edit's file copied through
    /// [`keep_copy_then_answer`], a command's window opened through
    /// [`ClaudeCommandWindows::open_then_answer`].
    CaptureBeforeTool {
        /// The request's id.
        request_id: String,
        /// The capture the call takes.
        capture: ClaudeToolCapture,
    },
    /// Answer it with no decision, then close the window of the command call `tool_use_id` as
    /// [`ClaudeCommandWindows::take_post_hook`] says: a post-tool hook on a command that runs
    /// with no wrapper.
    CaptureAfterTool {
        /// The request's id.
        request_id: String,
        /// The call the hook ran after.
        tool_use_id: String,
        /// How the call ended.
        end: ClaudeCommandEnd,
    },
    /// Answer it once the shell call it carries is checked for background work, through
    /// [`answer_background_work_check`].
    CheckBackgroundWork {
        /// The request's id.
        request_id: String,
        /// The shell call the hook was asked about.
        call: ClaudeShellCall,
        /// The call's tool-use id, `None` where the hook names none.
        tool_use_id: Option<String>,
        /// The calling helper's id, `None` on the lead.
        agent_id: Option<String>,
    },
    /// Answer or hold it through [`route_helper_start`](helper_calls::route_helper_start), which checks the session's posture before
    /// the pause decides: a call of the helper tool, by the lead or a helper.
    CheckHelperStart {
        /// The request's id.
        request_id: String,
        /// The calling helper's id, `None` on the lead.
        agent_id: Option<String>,
        /// What the call asked for, where it names a model or an effort its helper starts on.
        helper_call: Option<ClaudeHelperCall>,
    },
    /// Answer or hold it through [`route_message_target`](helper_calls::route_message_target), which checks the helper a message call
    /// aims at before the pause decides: a call of the message tool that names a recipient.
    CheckMessageTarget {
        /// The request's id.
        request_id: String,
        /// The calling helper's id, `None` on the lead.
        agent_id: Option<String>,
        /// The recipient the call names.
        to: String,
    },
    /// Answer or hold it through [`route_helper_wake`](helper_calls::route_helper_wake), which reads whether the helper a message
    /// call aims at has ended before the helper limit decides: a message call that names a
    /// recipient, seen by the helper-limit hook.
    CheckHelperWake {
        /// The request's id.
        request_id: String,
        /// The calling helper's id, `None` on the lead.
        agent_id: Option<String>,
        /// The message call's id, which the woken helper's start names as its parent.
        tool_use_id: String,
        /// The recipient the call names.
        to: String,
    },
    /// Answer it through [`answer_peer_send`], which reads whether the recipient a message call
    /// names is another session: a message call that names a recipient, seen by the send hook.
    ///
    /// [`answer_peer_send`]: crate::driver::claude::hooks::peer_send::answer_peer_send
    CheckPeerSend {
        /// The request's id.
        request_id: String,
        /// The recipient the call names.
        to: String,
    },
    /// Answer it with no decision once the helper call it names is forgotten: a failed call of the
    /// helper tool, which starts no helper.
    ForgetHelperCall {
        /// The request's id.
        request_id: String,
        /// The failed call's id, `None` where the hook names none.
        call_id: Option<String>,
    },
    /// Forget what the withdrawn request's helper call asked for, then hand the withdrawal on to
    /// the event side.
    Withdrawn {
        /// The withdrawn request's id.
        request_id: String,
        /// The helper call a withdrawn helper-limit hold named, `None` where the limit held none.
        held_call_id: Option<String>,
    },
    /// Hand it on to the event side: every request the daemon's hooks do not answer.
    Forward(ClaudeInboundRequestEvent),
}

/// What a pre-tool hook's call takes before it is let run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeToolCapture {
    /// The copy of the file the call changes.
    Edit(EditCheckpointRequest),
    /// The window of the command the call runs with no wrapper, or the note of the shell call
    /// the wrapper runs.
    Command(ClaudeCommandTarget),
}

/// The helper whose call a pause holds, and whether this hold is the pause taking effect.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ClaudeHeldHelper {
    /// The helper's agent id.
    pub(crate) agent_id: String,
    /// Whether the helper's pause took effect with this hold.
    pub(crate) has_taken_effect: bool,
}

/// The members of a hook's input the daemon's hooks read.
#[derive(Deserialize)]
pub(in crate::driver::claude::hooks) struct HookInput {
    #[serde(default, deserialize_with = "read_lenient")]
    agent_id: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    tool_name: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    tool_use_id: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    tool_input: Option<HookToolInput>,
    #[serde(default, deserialize_with = "read_lenient")]
    cwd: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    tool_response: Option<HookToolResponse>,
    #[serde(default, deserialize_with = "read_lenient")]
    error: Option<String>,
}

// The members of a post-tool hook's tool response the daemon's hooks read: the background task a
// shell call left running, or a `Monitor` call's task.
#[derive(Deserialize)]
struct HookToolResponse {
    #[serde(
        default,
        rename = "backgroundTaskId",
        deserialize_with = "read_lenient"
    )]
    background_task_id: Option<String>,
    #[serde(default, rename = "taskId", deserialize_with = "read_lenient")]
    task_id: Option<String>,
}

// The members of a hooked tool call's input the daemon's hooks read: a shell call's, the recipient
// of a message call, the file a file-changing call names, and the type, model and effort a helper
// call asks for.
#[derive(Deserialize)]
struct HookToolInput {
    #[serde(default, deserialize_with = "read_lenient")]
    command: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    run_in_background: Option<bool>,
    // Only whether a limit is set is read; Claude Code checks its type before the hook runs.
    #[serde(default)]
    timeout: Option<serde::de::IgnoredAny>,
    #[serde(default, deserialize_with = "read_lenient")]
    to: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    file_path: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    notebook_path: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    subagent_type: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    model: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    effort: Option<String>,
}

/// What a helper's `Agent` call asked for, read from its pre-tool hook: the model and effort it
/// names, by its call id.
#[derive(Debug)]
pub(crate) struct ClaudeHelperCall {
    /// The call's id, which its helper's start names.
    pub(crate) call_id: String,
    /// The hook request that carried it, which a withdrawal names.
    pub(crate) request_id: String,
    /// The calling helper's agent id, `None` on the lead's call.
    pub(crate) caller_agent_id: Option<String>,
    /// The model the call names.
    pub(crate) model_id: Option<ProviderToken>,
    /// The effort the call names, in Claude Code's word.
    pub(crate) effort: Option<ProviderToken>,
}

// The subagent type Claude Code starts on the caller's own model and effort, whatever its call
// names.
const CLAUDE_FORK_SUBAGENT_TYPE: &str = "fork";

// What the helper call `call_id` asks for: `None` where it names no call id, is a fork, or names no
// model or effort the contract holds.
fn read_helper_call(
    call_id: Option<String>,
    input: Option<&HookInput>,
    request_id: &str,
    caller_agent_id: Option<&str>,
) -> Option<ClaudeHelperCall> {
    let call_id = call_id?;
    let tool_input = input?.tool_input.as_ref()?;
    if tool_input.subagent_type.as_deref() == Some(CLAUDE_FORK_SUBAGENT_TYPE) {
        return None;
    }
    let token = |text: &Option<String>| text.clone().and_then(|text| ProviderToken::new(text).ok());
    let model_id = token(&tool_input.model);
    let effort = token(&tool_input.effort);
    if model_id.is_none() && effort.is_none() {
        return None;
    }
    Some(ClaudeHelperCall {
        call_id,
        request_id: request_id.to_owned(),
        caller_agent_id: caller_agent_id.map(str::to_owned),
        model_id,
        effort,
    })
}

/// The parts of a shell call the background-work hook reads.
#[derive(Debug, Default)]
pub(crate) struct ClaudeShellCall {
    /// The command line, `None` where the call carries none.
    pub(crate) command: Option<String>,
    /// Whether the call runs in the background with no time limit of its own, which Claude Code
    /// stops after 30 minutes.
    pub(crate) is_untimed_background: bool,
}

impl ClaudeShellCall {
    fn of(tool_input: HookToolInput) -> Self {
        Self {
            command: tool_input.command.filter(|command| !command.is_empty()),
            is_untimed_background: tool_input.run_in_background == Some(true)
                && tool_input.timeout.is_none(),
        }
    }
}

/// The reason the background-work hook gives a background shell call that sets no time limit.
pub(crate) const UNTIMED_BACKGROUND_REASON: &str = "Not started: a command run with \
    run_in_background and no timeout is stopped after 30 minutes. Call Bash again with `timeout` \
    set to how long you expect it to run, plus a margin, in milliseconds; or, for a server, a \
    watcher or anything meant to keep running until someone stops it, start it with shell_run \
    instead.";

lenient_object!(HookInput, HookToolInput, HookToolResponse);

/// Routes one request event off a session's process, at the session's `level`: a withdrawal also
/// withdraws a held pause or helper start; a call of the helper tool goes to the helper-start
/// check, carrying the model and effort the call asks for, and a call of the message tool that
/// names a recipient to the message-target check, before the pause decides; a pause callback, and a
/// helper-limit callback on the helper tool, is answered or held here, while one on the message
/// tool that names a recipient goes to the helper-wake check and any other passes; a failed helper
/// call's callback forgets what the call asked for; the send hook's callback on a message call that
/// names a recipient goes to the send check, and any other passes; a helper's post-tool and stop
/// callbacks carry its waiting words; a command's post-tool and failure callbacks close its window,
/// or pass where they name no call; the background-work callback is checked; the question hook
/// goes on only at Sandboxed and the denial hook only at Reviewed, both registered at every level
/// since a live process can move, and pass with no decision off them; anything else goes on.
pub(crate) fn route_claude_request(
    event: ClaudeInboundRequestEvent,
    session_id: &SessionId,
    level: Option<PermissionLevel>,
    pauses: &mut ClaudeRunPauses,
    helpers: &mut ClaudeHelperLimit,
    helper_steers: &mut ClaudeHelperSteers,
) -> ClaudeRequestRoute {
    let request = match event {
        ClaudeInboundRequestEvent::Cancel { request_id } => {
            pauses.withdraw_callback(session_id, &request_id);
            let held_call_id =
                helpers.withdraw_start(session_id, ClaudeCountedProcess::Session, &request_id);
            return ClaudeRequestRoute::Withdrawn {
                request_id,
                held_call_id,
            };
        }
        ClaudeInboundRequestEvent::Request(request) => request,
    };
    let ClaudeInboundRequestBody::HookCallback(callback) = &request.body else {
        return ClaudeRequestRoute::Forward(ClaudeInboundRequestEvent::Request(request));
    };
    let Some(hook) = callback.callback_id.as_deref().and_then(RegisteredHook::of) else {
        return ClaudeRequestRoute::Forward(ClaudeInboundRequestEvent::Request(request));
    };
    let input = read_hook_input(callback);
    let agent_id = hook_agent_id(input.as_ref());
    let is_helper_start = is_helper_tool_call(input.as_ref());
    let message_to = message_recipient(input.as_ref());
    let call_id = hooked_call_id(callback, input.as_ref());
    let request_id = request.request_id.clone();
    let pass_off_level = |at: PermissionLevel, request| {
        if level == Some(at) {
            ClaudeRequestRoute::Forward(ClaudeInboundRequestEvent::Request(request))
        } else {
            ClaudeRequestRoute::Answer {
                request_id: request_id.clone(),
                answer: ClaudeHookAnswer::Pass,
            }
        }
    };
    match hook {
        // The check comes before the pause, since a paused helper's call is held and later
        // released straight from the pause store.
        RegisteredHook::PauseBeforeTool if is_helper_start => {
            ClaudeRequestRoute::CheckHelperStart {
                helper_call: read_helper_call(
                    call_id,
                    input.as_ref(),
                    &request.request_id,
                    agent_id.as_deref(),
                ),
                request_id: request.request_id,
                agent_id,
            }
        }
        RegisteredHook::PauseBeforeTool => {
            // Checked before the pause for the same reason as a helper start.
            if let Some(to) = message_to {
                return ClaudeRequestRoute::CheckMessageTarget {
                    request_id: request.request_id,
                    agent_id,
                    to,
                };
            }
            let capture = read_hooked_capture(
                session_id,
                call_id.as_deref(),
                input.as_ref(),
                agent_id.as_deref(),
            );
            route_before_tool(pauses, session_id, request.request_id, agent_id, capture)
        }
        RegisteredHook::PauseAfterBatch => pause_route(
            pauses.answer_after_batch(session_id, agent_id.as_deref()),
            request.request_id,
            agent_id,
        ),
        RegisteredHook::BackgroundWork => ClaudeRequestRoute::CheckBackgroundWork {
            tool_use_id: call_id,
            call: input
                .and_then(|input| input.tool_input)
                .map(ClaudeShellCall::of)
                .unwrap_or_default(),
            request_id: request.request_id,
            agent_id,
        },
        RegisteredHook::HelperLimit => {
            let tool_use_id = call_id.unwrap_or_else(|| request.request_id.clone());
            if is_helper_start {
                let own = ClaudeCountedProcess::Session;
                let answer =
                    helpers.answer_start(session_id, own, &request.request_id, &tool_use_id);
                return helper_limit_route(answer, request.request_id);
            }
            match message_to {
                Some(to) => ClaudeRequestRoute::CheckHelperWake {
                    request_id: request.request_id,
                    agent_id,
                    tool_use_id,
                    to,
                },
                None => ClaudeRequestRoute::Answer {
                    request_id: request.request_id,
                    answer: ClaudeHookAnswer::Pass,
                },
            }
        }
        RegisteredHook::HelperSteerAfterTool => ClaudeRequestRoute::Answer {
            answer: helper_steers.answer_after_tool(*session_id, agent_id.as_deref()),
            request_id: request.request_id,
        },
        RegisteredHook::HelperSteerAtStop => ClaudeRequestRoute::Answer {
            answer: helper_steers.answer_at_stop(*session_id, agent_id.as_deref()),
            request_id: request.request_id,
        },
        RegisteredHook::PeerSend => match message_to {
            Some(to) => ClaudeRequestRoute::CheckPeerSend {
                request_id: request.request_id,
                to,
            },
            None => ClaudeRequestRoute::Answer {
                request_id: request.request_id,
                answer: ClaudeHookAnswer::Pass,
            },
        },
        RegisteredHook::CaptureAfterTool => {
            let response = input
                .as_ref()
                .and_then(|input| input.tool_response.as_ref());
            let end = ClaudeCommandEnd::read_after_tool(
                response.and_then(|response| response.background_task_id.as_deref()),
                response.and_then(|response| response.task_id.as_deref()),
            );
            capture_after_tool_route(call_id, request.request_id, end)
        }
        RegisteredHook::CaptureAfterFailedTool => {
            let end = ClaudeCommandEnd::read_after_failed_tool(
                input.as_ref().and_then(|input| input.error.as_deref()),
            );
            capture_after_tool_route(call_id, request.request_id, end)
        }
        RegisteredHook::HelperCallFailed => ClaudeRequestRoute::ForgetHelperCall {
            call_id,
            request_id: request.request_id,
        },
        RegisteredHook::QuestionBridge => pass_off_level(PermissionLevel::Sandboxed, request),
        RegisteredHook::PermissionDenied => pass_off_level(PermissionLevel::Reviewed, request),
    }
}

/// The background-work hook's answer to a shell `call`, at every level, since a level that never
/// asks never reaches the answer to an ask: denied, with the reason the agent reads, when the line
/// starts some provider's background work or the call runs in the background with no time limit;
/// any other call passes. The line is read once, on `shell_lines`' blocking thread.
pub(crate) async fn answer_background_work_check(
    shell_lines: &ShellLineReadingBound,
    background_work: &Arc<BackgroundWorkForms>,
    call: ClaudeShellCall,
) -> ClaudeHookAnswer {
    let untimed_answer = if call.is_untimed_background {
        ClaudeHookAnswer::Deny {
            reason: UNTIMED_BACKGROUND_REASON.to_owned(),
        }
    } else {
        ClaudeHookAnswer::Pass
    };
    let Some(command) = call.command else {
        return untimed_answer;
    };
    let background_work = Arc::clone(background_work);
    let refusal = shell_lines
        .read(command.len(), move |reader| {
            let reading = reader.read(&command);
            refuse_background_work(&background_work, reader, &reading)
        })
        .await
        .expect("a shell-line read never panics, and a panic ends the daemon");
    refusal.map_or(untimed_answer, |reason| ClaudeHookAnswer::Deny {
        reason: reason.to_owned(),
    })
}

// The pause's route for a pre-tool callback taking `capture`: the pause decides first, so a
// denied call takes none and a held one keeps it for its continue; a passed call is captured
// before its answer, and any other call is answered now.
fn route_before_tool(
    pauses: &mut ClaudeRunPauses,
    session_id: &SessionId,
    request_id: String,
    agent_id: Option<String>,
    mut capture: Option<ClaudeToolCapture>,
) -> ClaudeRequestRoute {
    let answer =
        pauses.answer_before_tool(session_id, agent_id.as_deref(), &request_id, &mut capture);
    match (answer, capture) {
        (ClaudePauseAnswer::Answer(ClaudeHookAnswer::Pass), Some(capture)) => {
            ClaudeRequestRoute::CaptureBeforeTool {
                request_id,
                capture,
            }
        }
        (answer, _) => pause_route(answer, request_id, agent_id),
    }
}

// A command's post-tool route for the call `call_id`, ended as `end`; a callback naming no call
// passes now.
fn capture_after_tool_route(
    call_id: Option<String>,
    request_id: String,
    end: ClaudeCommandEnd,
) -> ClaudeRequestRoute {
    match call_id {
        Some(tool_use_id) => ClaudeRequestRoute::CaptureAfterTool {
            request_id,
            tool_use_id,
            end,
        },
        None => ClaudeRequestRoute::Answer {
            request_id,
            answer: ClaudeHookAnswer::Pass,
        },
    }
}

/// Answers one request Claude Code holds through `channel`. An answer that cannot be written
/// leaves Claude Code waiting on it for good, so it is recorded as `ControlAnswerFailed` and the
/// process is stopped, for the restart path to bring the session back.
pub(crate) async fn answer_claude_request(
    channel: &dyn ClaudeProcessChannel,
    session_id: &SessionId,
    provider_account_id: &ProviderAccountId,
    request_id: String,
    answer: &impl Serialize,
) {
    let answer = serde_json::value::to_raw_value(answer)
        .expect("an answer the daemon composes always serializes");
    let failure = match channel
        .answer_inbound_request(request_id.clone(), answer)
        .await
    {
        ClaudeWriteAttempt::Written => return,
        ClaudeWriteAttempt::Failed { cause, .. } => cause,
    };
    emit_driver_diagnostic(&DriverDiagnosticRecord {
        provider: DESCRIPTOR.provider_id(),
        provider_account_id: Some(provider_account_id.clone()),
        kind: DriverDiagnosticKind::ControlAnswerFailed,
        raw_wire_type: None,
        disposition_reason: bound_failure_detail(
            &describe_error(&failure),
            UNSPECIFIED_PROVIDER_FAILURE_DETAIL.clone(),
        )
        .into_string(),
        details: serde_json::Map::from_iter([
            (
                "sessionId".to_owned(),
                serde_json::Value::from(session_id.to_string()),
            ),
            ("requestId".to_owned(), serde_json::Value::from(request_id)),
        ]),
    });
    channel.terminate().await;
}

/// Answers the callbacks a helper's continue `released`, in order: one carrying an edit once its
/// file's copy is kept through `edit_checkpoint`, one carrying a command once its window is open
/// through `command_windows` as a window of `process`, the rest with their own answers. An answer
/// that cannot be written stops the process, as [`answer_claude_request`] does.
pub(crate) async fn answer_released_callbacks(
    edit_checkpoint: Option<&Arc<dyn EditCheckpoint>>,
    command_windows: &ClaudeCommandWindows,
    channel: &dyn ClaudeProcessChannel,
    session_id: &SessionId,
    process: ProviderProcessIdentity,
    provider_account_id: &ProviderAccountId,
    released: Vec<ClaudeReleasedCallback>,
) {
    for callback in released {
        match callback.capture {
            Some(ClaudeToolCapture::Command(target)) => {
                let opening = command_windows.begin_open(*session_id, process, target);
                command_windows
                    .open_then_answer(opening, channel, provider_account_id, callback.request_id)
                    .await;
            }
            Some(ClaudeToolCapture::Edit(edit)) => {
                keep_copy_then_answer(
                    edit_checkpoint,
                    channel,
                    provider_account_id,
                    callback.request_id,
                    edit,
                )
                .await;
            }
            None => {
                answer_claude_request(
                    channel,
                    session_id,
                    provider_account_id,
                    callback.request_id,
                    &callback.answer,
                )
                .await;
            }
        }
    }
}

// A pause's route: an answer now, or a hold, which names the helper it holds.
fn pause_route(
    answer: ClaudePauseAnswer,
    request_id: String,
    agent_id: Option<String>,
) -> ClaudeRequestRoute {
    match answer {
        ClaudePauseAnswer::Answer(answer) => ClaudeRequestRoute::Answer { request_id, answer },
        ClaudePauseAnswer::Hold { has_taken_effect } => ClaudeRequestRoute::Held {
            helper: agent_id.map(|agent_id| ClaudeHeldHelper {
                agent_id,
                has_taken_effect,
            }),
        },
    }
}

// The capture the pre-tool hook's call `tool_use_id` by the helper `agent_id` or the lead takes,
// read from its tool, its input and the hook's folder: the edit it makes, else the command it runs
// with no wrapper.
fn read_hooked_capture(
    session_id: &SessionId,
    tool_use_id: Option<&str>,
    input: Option<&HookInput>,
    agent_id: Option<&str>,
) -> Option<ClaudeToolCapture> {
    let input = input?;
    let tool_name = input.tool_name.as_deref()?;
    let tool_input = input.tool_input.as_ref();
    if let Some(edit) = read_claude_edit(
        session_id,
        tool_name,
        tool_input.and_then(|tool_input| tool_input.file_path.as_deref()),
        tool_input.and_then(|tool_input| tool_input.notebook_path.as_deref()),
        input.cwd.as_deref(),
        tool_use_id,
    ) {
        return Some(ClaudeToolCapture::Edit(edit));
    }
    read_claude_command_target(
        session_id,
        tool_name,
        tool_input.and_then(|tool_input| tool_input.command.as_deref()),
        tool_use_id,
        agent_id,
        tool_input.and_then(|tool_input| tool_input.run_in_background),
    )
    .map(ClaudeToolCapture::Command)
}

/// The hook's input, `None` where it carries none or none the hooks read.
pub(in crate::driver::claude::hooks) fn read_hook_input(
    callback: &ClaudeHookCallback,
) -> Option<HookInput> {
    callback
        .input
        .as_deref()
        .and_then(|input: &RawValue| serde_json::from_str(input.get()).ok())
}

/// The calling helper's id, never empty; `None` on the lead.
pub(in crate::driver::claude::hooks) fn hook_agent_id(input: Option<&HookInput>) -> Option<String> {
    input
        .and_then(|input| input.agent_id.clone())
        .filter(|id| !id.is_empty())
}

/// Whether the hooked call is one of the helper tool.
pub(in crate::driver::claude::hooks) fn is_helper_tool_call(input: Option<&HookInput>) -> bool {
    input.and_then(|input| input.tool_name.as_deref()) == Some(CLAUDE_HELPER_TOOL_NAME)
}

/// The recipient a call of the message tool names, never empty; `None` for any other call.
pub(in crate::driver::claude::hooks) fn message_recipient(
    input: Option<&HookInput>,
) -> Option<String> {
    input
        .filter(|input| input.tool_name.as_deref() == Some(CLAUDE_MESSAGE_TOOL_NAME))
        .and_then(|input| input.tool_input.as_ref()?.to.clone())
        .filter(|to| !to.is_empty())
}

/// The hooked call's id: the callback's, else its input's, never empty.
pub(in crate::driver::claude::hooks) fn hooked_call_id(
    callback: &ClaudeHookCallback,
    input: Option<&HookInput>,
) -> Option<String> {
    callback
        .tool_use_id
        .clone()
        .or_else(|| input?.tool_use_id.clone())
        .filter(|id| !id.is_empty())
}

#[cfg(test)]
mod tests;
