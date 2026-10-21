//! Routes each request a live Claude Code process sends: the daemon's own pause, helper-limit and
//! background-work hooks are answered here, and every other request (tool asks, dialogs, the
//! question hook, a reviewer's block) goes on to the event side, which answers it or leaves it
//! pending at the provider.

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;

use crate::error_description::describe_error;
use crate::policy::background_work::refuse_background_work;
use crate::policy::shell_commands::reading_bound::ShellLineReadingBound;
use crate::provider::driver::claude::DESCRIPTOR;
use crate::provider::driver::claude::hooks::helper_limit::{
    ClaudeHelperLimit, ClaudeHelperStartAnswer,
};
use crate::provider::driver::claude::hooks::pause::{
    ClaudeHookAnswer, ClaudePauseAnswer, ClaudeRunPauses,
};
use crate::provider::driver::claude::hooks::registration::ClaudeHookCallback as RegisteredHook;
use crate::provider::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::provider::driver::claude::session::transport::inbound::{
    ClaudeHookCallback, ClaudeInboundRequestBody, ClaudeInboundRequestEvent,
};
use crate::provider::driver::claude::session::transport::user_message::ClaudeWriteAttempt;
use crate::provider::driver::contract::bound_failure_detail;
use crate::provider::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::provider::driver::error_causes::UNSPECIFIED_PROVIDER_FAILURE_DETAIL;
use crate::provider::lenient_json::{lenient_object, read_lenient};

/// Where one request a process sent goes.
#[expect(
    dead_code,
    reason = "the Claude driver's session task acts on each route it reads"
)]
#[derive(Debug)]
pub(crate) enum ClaudeRequestRoute {
    /// Answer it now.
    Answer {
        /// The request's id.
        request_id: String,
        /// The answer.
        answer: ClaudeHookAnswer,
    },
    /// Leave it unanswered until a continue or a finished helper lets it go; `helper_held` names
    /// a helper whose pause just took effect.
    Held {
        /// The helper whose pause took effect with this hold.
        helper_held: Option<String>,
    },
    /// Answer it once the shell command it carries is read for background work, through
    /// [`answer_background_work_check`].
    CheckBackgroundWork {
        /// The request's id.
        request_id: String,
        /// The command, `None` where the call carries none.
        command: Option<String>,
    },
    /// Hand it on to the event side: every request the daemon's hooks do not answer, and every
    /// withdrawal.
    Forward(ClaudeInboundRequestEvent),
}

// The members of a hook's input the daemon's hooks read.
#[derive(Deserialize)]
struct HookInput {
    #[serde(default, deserialize_with = "read_lenient")]
    agent_id: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    tool_use_id: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    tool_input: Option<ShellToolInput>,
}

#[derive(Deserialize)]
struct ShellToolInput {
    #[serde(default, deserialize_with = "read_lenient")]
    command: Option<String>,
}

lenient_object!(HookInput, ShellToolInput);

/// Routes one request event off a session's process, at the session's `level`: a withdrawal also
/// withdraws a held pause or helper start; a pause or helper-limit callback is answered or held
/// here; the background-work callback is checked; the question hook goes on only at Sandboxed and
/// the denial hook only at Reviewed, both registered at every level since a live process can move,
/// and pass with no decision off them; anything else goes on.
#[expect(
    dead_code,
    reason = "the Claude driver's session task routes each request event through it"
)]
pub(crate) fn route_claude_request(
    event: ClaudeInboundRequestEvent,
    session_id: &SessionId,
    level: Option<PermissionLevel>,
    pauses: &mut ClaudeRunPauses,
    helpers: &mut ClaudeHelperLimit,
) -> ClaudeRequestRoute {
    let request = match event {
        ClaudeInboundRequestEvent::Cancel { request_id } => {
            pauses.withdraw_callback(session_id, &request_id);
            helpers.withdraw_start(session_id, &request_id);
            return ClaudeRequestRoute::Forward(ClaudeInboundRequestEvent::Cancel { request_id });
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
    let agent_id = input
        .as_ref()
        .and_then(|input| input.agent_id.clone())
        .filter(|id| !id.is_empty());
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
        RegisteredHook::PauseBeforeTool => pause_route(
            pauses.answer_before_tool(session_id, agent_id.as_deref(), &request.request_id),
            request.request_id,
            agent_id,
        ),
        RegisteredHook::PauseAfterBatch => pause_route(
            pauses.answer_after_batch(session_id, agent_id.as_deref()),
            request.request_id,
            agent_id,
        ),
        RegisteredHook::BackgroundWork => ClaudeRequestRoute::CheckBackgroundWork {
            command: input
                .and_then(|input| input.tool_input)
                .and_then(|tool_input| tool_input.command)
                .filter(|command| !command.is_empty()),
            request_id: request.request_id,
        },
        RegisteredHook::HelperLimit => {
            let tool_use_id = callback
                .tool_use_id
                .clone()
                .or_else(|| input.and_then(|input| input.tool_use_id))
                .filter(|id| !id.is_empty())
                .unwrap_or_else(|| request.request_id.clone());
            match helpers.answer_start(session_id, &request.request_id, &tool_use_id) {
                ClaudeHelperStartAnswer::Admit => ClaudeRequestRoute::Answer {
                    request_id: request.request_id,
                    answer: ClaudeHookAnswer::Pass,
                },
                ClaudeHelperStartAnswer::Hold => ClaudeRequestRoute::Held { helper_held: None },
            }
        }
        RegisteredHook::QuestionBridge => pass_off_level(PermissionLevel::Sandboxed, request),
        RegisteredHook::PermissionDenied => pass_off_level(PermissionLevel::Reviewed, request),
    }
}

/// The background-work hook's answer to a shell call running `command`: denied, with the reason
/// the agent reads, when the line starts some provider's background work, at every level, since a
/// level that never asks never reaches the answer to an ask; any other call passes. The line is
/// read once, on `shell_lines`' blocking thread.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Claude driver's session task answers the background-work hook through it"
    )
)]
pub(crate) async fn answer_background_work_check(
    shell_lines: &ShellLineReadingBound,
    command: Option<String>,
) -> ClaudeHookAnswer {
    let Some(command) = command else {
        return ClaudeHookAnswer::Pass;
    };
    let refusal = shell_lines
        .read(command.len(), move |reader| {
            let reading = reader.read(&command);
            refuse_background_work(reader, &reading)
        })
        .await
        .expect("a shell-line read never panics, and a panic ends the daemon");
    refusal.map_or(ClaudeHookAnswer::Pass, |reason| ClaudeHookAnswer::Deny {
        reason: reason.to_owned(),
    })
}

/// Answers one request Claude Code holds through `channel`. An answer that cannot be written
/// leaves Claude Code waiting on it for good, so it is recorded as `ControlAnswerFailed` and the
/// process is stopped, for the restart path to bring the session back.
#[expect(
    dead_code,
    reason = "the Claude driver's session task writes every hook and request answer through it"
)]
pub(crate) async fn answer_claude_request(
    channel: &dyn ClaudeProcessChannel,
    session_id: &SessionId,
    provider_account_id: Option<&ProviderAccountId>,
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
        provider_account_id: provider_account_id.cloned(),
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

// A pause's route: an answer now, or a hold, which names the helper when it is the helper's pause
// taking effect.
fn pause_route(
    answer: ClaudePauseAnswer,
    request_id: String,
    agent_id: Option<String>,
) -> ClaudeRequestRoute {
    match answer {
        ClaudePauseAnswer::Answer(answer) => ClaudeRequestRoute::Answer { request_id, answer },
        ClaudePauseAnswer::Hold { has_taken_effect } => ClaudeRequestRoute::Held {
            helper_held: agent_id.filter(|_| has_taken_effect),
        },
    }
}

fn read_hook_input(callback: &ClaudeHookCallback) -> Option<HookInput> {
    callback
        .input
        .as_deref()
        .and_then(|input: &RawValue| serde_json::from_str(input.get()).ok())
}

#[cfg(test)]
mod tests {
    use super::answer_background_work_check;
    use crate::policy::shell_commands::reading_bound::ShellLineReadingBound;
    use crate::provider::driver::claude::hooks::pause::ClaudeHookAnswer;

    // Killed by a hook that lets background work through, or that refuses an ordinary command.
    #[tokio::test]
    async fn the_background_work_hook_denies_background_work_and_passes_the_rest() {
        let shell_lines = ShellLineReadingBound::new(4096);

        let refused =
            answer_background_work_check(&shell_lines, Some("bash -c 'claude --bg x'".to_owned()))
                .await;
        let passed = answer_background_work_check(&shell_lines, Some("ls -la".to_owned())).await;

        assert!(matches!(refused, ClaudeHookAnswer::Deny { .. }));
        assert_eq!(passed, ClaudeHookAnswer::Pass);
    }
}
