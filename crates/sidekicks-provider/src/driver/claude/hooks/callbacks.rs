//! Routes each request a live Claude Code process sends: the daemon's own pause, helper-start,
//! helper-limit and background-work hooks are answered here, and every other request (tool asks,
//! dialogs, the question hook, a reviewer's block) goes on to the event side, which answers it or
//! leaves it pending at the provider.

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;
use sidekicks_std::error_description::describe_error;
use sidekicks_std::mutex_lock::lock;

use crate::background_work::{BackgroundWorkForms, refuse_background_work};
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::hooks::helper_limit::{ClaudeHelperLimit, ClaudeHelperStartAnswer};
use crate::driver::claude::hooks::helper_steers::ClaudeHelperSteers;
use crate::driver::claude::hooks::pause::{ClaudeHookAnswer, ClaudePauseAnswer, ClaudeRunPauses};
use crate::driver::claude::hooks::registration::{
    CLAUDE_HELPER_TOOL_NAME, ClaudeHookCallback as RegisteredHook,
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
use crate::run::posture::resolve_posture;

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
    /// Leave it unanswered until a continue or a finished helper lets it go; `helper_held` names
    /// a helper whose pause just took effect.
    Held {
        /// The helper whose pause took effect with this hold.
        helper_held: Option<String>,
    },
    /// Answer it once the shell call it carries is checked for background work, through
    /// [`answer_background_work_check`].
    CheckBackgroundWork {
        /// The request's id.
        request_id: String,
        /// The shell call the hook was asked about.
        call: ClaudeShellCall,
    },
    /// Answer or hold it through [`route_helper_start`], which checks the session's posture before
    /// the pause decides: a call of the helper tool, by the lead or a helper.
    CheckHelperStart {
        /// The request's id.
        request_id: String,
        /// The calling helper's id, `None` on the lead.
        agent_id: Option<String>,
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
    tool_name: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    tool_use_id: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    tool_input: Option<ShellToolInput>,
}

#[derive(Deserialize)]
struct ShellToolInput {
    #[serde(default, deserialize_with = "read_lenient")]
    command: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    run_in_background: Option<bool>,
    // Only whether a limit is set is read; Claude Code checks its type before the hook runs.
    #[serde(default)]
    timeout: Option<serde::de::IgnoredAny>,
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
    fn of(tool_input: ShellToolInput) -> Self {
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

lenient_object!(HookInput, ShellToolInput);

/// Routes one request event off a session's process, at the session's `level`: a withdrawal also
/// withdraws a held pause or helper start; a call of the helper tool goes to the helper-start
/// check before the pause decides; a pause or helper-limit callback is answered or held here; a
/// helper's post-tool and stop callbacks carry its waiting words; the background-work callback is
/// checked; the question hook goes on only at Sandboxed and the denial hook only at
/// Reviewed, both registered at every level since a live process can move, and pass with no
/// decision off them; anything else goes on.
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
    let is_helper_start = input.as_ref().and_then(|input| input.tool_name.as_deref())
        == Some(CLAUDE_HELPER_TOOL_NAME);
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
                request_id: request.request_id,
                agent_id,
            }
        }
        RegisteredHook::PauseBeforeTool => {
            route_before_tool(pauses, session_id, request.request_id, agent_id)
        }
        RegisteredHook::PauseAfterBatch => pause_route(
            pauses.answer_after_batch(session_id, agent_id.as_deref()),
            request.request_id,
            agent_id,
        ),
        RegisteredHook::BackgroundWork => ClaudeRequestRoute::CheckBackgroundWork {
            call: input
                .and_then(|input| input.tool_input)
                .map(ClaudeShellCall::of)
                .unwrap_or_default(),
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
        RegisteredHook::HelperSteerAfterTool => ClaudeRequestRoute::Answer {
            answer: helper_steers.answer_after_tool(*session_id, agent_id.as_deref()),
            request_id: request.request_id,
        },
        RegisteredHook::HelperSteerAtStop => ClaudeRequestRoute::Answer {
            answer: helper_steers.answer_at_stop(*session_id, agent_id.as_deref()),
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

/// The route of a helper start, the call `request_id` of the helper tool by the helper `agent_id`
/// or the lead, once the session's `posture` is checked: denied, with the refusal's cause in the
/// reason the agent reads, where the posture no longer resolves; otherwise, or where the session
/// holds no posture, answered or held as the pause says. Only a writable root costs a path read,
/// so only Sandboxed reads any; `pauses` is locked only after the read.
pub(crate) async fn route_helper_start(
    posture: Option<&ExecutionPosture>,
    pauses: &Mutex<ClaudeRunPauses>,
    session_id: &SessionId,
    request_id: String,
    agent_id: Option<String>,
) -> ClaudeRequestRoute {
    if let Some(posture) = posture
        && let Err(rejection) = resolve_posture(posture).await
    {
        return ClaudeRequestRoute::Answer {
            request_id,
            answer: ClaudeHookAnswer::Deny {
                reason: helper_start_refused_reason(&describe_error(&rejection)),
            },
        };
    }
    route_before_tool(&mut lock(pauses), session_id, request_id, agent_id)
}

// The reason a refused helper start gives the agent, `cause` saying why the level cannot run.
fn helper_start_refused_reason(cause: &str) -> String {
    format!(
        "Not started: this session's permission level cannot run right now, because {cause}. \
         Continue without a helper, or tell the person."
    )
}

// The pause's route for a pre-tool callback: an answer now, or a hold that names the helper when
// its pause takes effect with it.
fn route_before_tool(
    pauses: &mut ClaudeRunPauses,
    session_id: &SessionId,
    request_id: String,
    agent_id: Option<String>,
) -> ClaudeRequestRoute {
    pause_route(
        pauses.answer_before_tool(session_id, agent_id.as_deref(), &request_id),
        request_id,
        agent_id,
    )
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
    use crate::driver::test_registry::fixed_session_id;
    use std::path::Path;
    use std::sync::{Arc, Mutex};

    use rstest::rstest;
    use serde_json::json;
    use serde_json::value::RawValue;
    use sidekicks_contracts::free_form_string::FilesystemPath;
    use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
    use sidekicks_contracts::session::controls::methods::PermissionLevel;
    use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;
    use sidekicks_std::error_description::describe_error;
    use sidekicks_std::mutex_lock::lock;

    use super::{
        ClaudeRequestRoute, ClaudeShellCall, ShellToolInput, UNTIMED_BACKGROUND_REASON,
        answer_background_work_check, helper_start_refused_reason, route_claude_request,
        route_helper_start,
    };
    use crate::background_work::BackgroundWorkForms;
    use crate::driver::PROVIDERS;
    use crate::driver::claude::hooks::helper_limit::ClaudeHelperLimit;
    use crate::driver::claude::hooks::helper_steers::ClaudeHelperSteers;
    use crate::driver::claude::hooks::pause::{ClaudeHookAnswer, ClaudeRunPauses};
    use crate::driver::claude::hooks::registration::ClaudeHookCallback as RegisteredHook;
    use crate::driver::claude::session::transport::inbound::{
        ClaudeHookCallback, ClaudeInboundRequest, ClaudeInboundRequestBody,
        ClaudeInboundRequestEvent,
    };
    use crate::run::posture::{compose_execution_posture, resolve_posture};

    // Routes one pre-tool callback for `tool_name`, called by the helper `agent_id` or the lead.
    fn route_pre_tool_call(
        pauses: &Mutex<ClaudeRunPauses>,
        tool_name: &str,
        agent_id: Option<&str>,
        request_id: &str,
    ) -> ClaudeRequestRoute {
        let mut input = json!({ "tool_name": tool_name });
        if let Some(agent_id) = agent_id {
            input["agent_id"] = agent_id.into();
        }
        let event = ClaudeInboundRequestEvent::Request(ClaudeInboundRequest {
            request_id: request_id.to_owned(),
            body: ClaudeInboundRequestBody::HookCallback(ClaudeHookCallback {
                callback_id: Some(RegisteredHook::PauseBeforeTool.id().to_owned()),
                tool_use_id: None,
                input: Some(RawValue::from_string(input.to_string()).expect("a JSON input")),
            }),
        });
        route_claude_request(
            event,
            &fixed_session_id(),
            Some(PermissionLevel::Sandboxed),
            &mut lock(pauses),
            &mut ClaudeHelperLimit::default(),
            &mut ClaudeHelperSteers::default(),
        )
    }

    // Routes one helper start through the route and the check, as the session's task does.
    async fn route_start(
        pauses: &Mutex<ClaudeRunPauses>,
        posture: &ExecutionPosture,
        agent_id: Option<&str>,
        request_id: &str,
    ) -> ClaudeRequestRoute {
        let ClaudeRequestRoute::CheckHelperStart {
            request_id,
            agent_id,
        } = route_pre_tool_call(pauses, "Agent", agent_id, request_id)
        else {
            panic!("a helper start goes to the check");
        };
        route_helper_start(
            Some(posture),
            pauses,
            &fixed_session_id(),
            request_id,
            agent_id,
        )
        .await
    }

    fn sandboxed_over(root: &Path) -> ExecutionPosture {
        compose_execution_posture(
            PermissionLevel::Sandboxed,
            FilesystemPath::new(root.to_string_lossy().into_owned()).expect("a valid path"),
        )
    }

    /// The answer a case expects: a pass, the time-limit denial, or another denial.
    #[derive(Debug)]
    enum Expected {
        Pass,
        UntimedDenial,
        BackgroundWorkDenial,
    }

    // Killed by a hook that lets a provider's background work through or refuses an ordinary
    // command; by a dropped or inverted time-limit check (an untimed background call passed, a
    // timed one denied); and by a line with an unterminated quote read as a refusal. Mutations:
    // in `answer_background_work_check`, `untimed_answer` always `Pass`; in
    // `ClaudeShellCall::of`, `timeout.is_none()` to `is_some()` or the condition dropped.
    #[rstest]
    #[case::provider_background_work(
        json!({"command": "bash -c 'claude --bg x'"}),
        Expected::BackgroundWorkDenial
    )]
    #[case::ordinary_command(json!({"command": "ls -la"}), Expected::Pass)]
    #[case::background_with_no_timeout(
        json!({"command": "npm run build", "run_in_background": true}),
        Expected::UntimedDenial
    )]
    #[case::background_with_a_timeout(
        json!({"command": "npm run build", "run_in_background": true, "timeout": 600_000}),
        Expected::Pass
    )]
    #[case::unterminated_quote(
        json!({"command": r#"claude --bg x && echo "unterminated"#}),
        Expected::Pass
    )]
    #[tokio::test]
    async fn the_background_work_hook_denies_background_work_and_untimed_background_calls(
        #[case] tool_input: serde_json::Value,
        #[case] expected: Expected,
    ) {
        let shell_lines = ShellLineReadingBound::new(4096);
        let background_work = Arc::new(BackgroundWorkForms::of_providers(PROVIDERS));
        let tool_input: ShellToolInput = serde_json::from_value(tool_input).expect("a tool input");

        let answer = answer_background_work_check(
            &shell_lines,
            &background_work,
            ClaudeShellCall::of(tool_input),
        )
        .await;

        match (expected, &answer) {
            (Expected::Pass, ClaudeHookAnswer::Pass) => {}
            (Expected::UntimedDenial, ClaudeHookAnswer::Deny { reason })
                if reason == UNTIMED_BACKGROUND_REASON => {}
            (Expected::BackgroundWorkDenial, ClaudeHookAnswer::Deny { reason })
                if reason != UNTIMED_BACKGROUND_REASON => {}
            (expected, answer) => panic!("expected {expected:?}, answered {answer:?}"),
        }
    }

    // Killed by the check skipped (the helper tool routed to the pause, or the check answering
    // `None` on a refusal) and by the check applied to every tool (the shell call routed to it).
    #[tokio::test]
    async fn a_helper_start_is_denied_where_the_sandboxed_root_is_gone_and_a_shell_call_passes() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let gone = scratch.path().join("repo.git");
        let posture = sandboxed_over(&gone);
        let pauses = Mutex::new(ClaudeRunPauses::default());

        let ClaudeRequestRoute::Answer {
            request_id,
            answer: ClaudeHookAnswer::Deny { reason },
        } = route_start(&pauses, &posture, None, "r1").await
        else {
            panic!("a posture whose root is gone refuses the helper start");
        };
        let rejection = resolve_posture(&posture)
            .await
            .expect_err("the root is gone");
        let cause = describe_error(&rejection);
        assert!(
            cause.starts_with(&format!("the writable root '{}'", gone.display())),
            "{cause}"
        );
        assert_eq!(request_id, "r1");
        assert_eq!(reason, helper_start_refused_reason(&cause));
        assert!(
            reason.starts_with(
                "Not started: this session's permission level cannot run right now, because "
            ) && reason.ends_with(". Continue without a helper, or tell the person."),
            "{reason}"
        );

        assert!(matches!(
            route_pre_tool_call(&pauses, "Bash", None, "r2"),
            ClaudeRequestRoute::Answer {
                answer: ClaudeHookAnswer::Pass,
                ..
            }
        ));
    }

    // Killed by a deny on every helper start (the check refusing a posture that resolves) and by
    // the pause skipped for a helper's start (the call answered at once while its helper is
    // paused).
    #[tokio::test]
    async fn a_resolvable_posture_passes_a_helper_start_and_a_paused_helpers_start_is_held() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let posture = sandboxed_over(scratch.path());
        let pauses = Mutex::new(ClaudeRunPauses::default());

        assert!(matches!(
            route_start(&pauses, &posture, None, "r1").await,
            ClaudeRequestRoute::Answer {
                answer: ClaudeHookAnswer::Pass,
                ..
            }
        ));
        lock(&pauses).pause_helper(&fixed_session_id(), "helper-a");
        let ClaudeRequestRoute::Held { helper_held } =
            route_start(&pauses, &posture, Some("helper-a"), "r2").await
        else {
            panic!("a paused helper's helper start is held");
        };
        assert_eq!(helper_held.as_deref(), Some("helper-a"));
    }
}
