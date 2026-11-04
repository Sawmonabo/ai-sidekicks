use std::error::Error;
use std::path::Path;
use std::sync::{Arc, Mutex};

use futures::FutureExt;
use futures::future::BoxFuture;
use rstest::rstest;
use serde_json::json;
use serde_json::value::RawValue;
use sidekicks_contracts::agent::tree::ChildHandle;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::control::StopTrigger;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;
use sidekicks_std::error_description::describe_error;
use sidekicks_std::mutex_lock::lock;

use super::{
    ClaudeHeldHelper, ClaudeRequestRoute, ClaudeShellCall, HookToolInput,
    UNTIMED_BACKGROUND_REASON, answer_background_work_check, helper_start_refused_reason,
    route_claude_request, route_helper_start, route_message_target,
};
use crate::background_work::BackgroundWorkForms;
use crate::driver::PROVIDERS;
use crate::driver::claude::hooks::helper_limit::ClaudeHelperLimit;
use crate::driver::claude::hooks::helper_steers::ClaudeHelperSteers;
use crate::driver::claude::hooks::pause::{ClaudeHookAnswer, ClaudeRunPauses};
use crate::driver::claude::hooks::registration::ClaudeHookCallback as RegisteredHook;
use crate::driver::claude::session::transport::inbound::{
    ClaudeHookCallback, ClaudeInboundRequest, ClaudeInboundRequestBody, ClaudeInboundRequestEvent,
};
use crate::driver::hook_pauses::{HELD_TARGET_REASON, target_unread_reason};
use crate::driver::run_control::HelperStopReason;
use crate::driver::test_registry::fixed_session_id;
use crate::port::agent_tree_lookup::{AgentTreeHelper, AgentTreeLookup};
use crate::run::posture::{compose_execution_posture, resolve_posture};

// Routes one pre-tool callback for `tool_name`, called by the helper `agent_id` or the lead,
// its input naming the recipient `to` when given.
fn route_pre_tool_call(
    pauses: &Mutex<ClaudeRunPauses>,
    tool_name: &str,
    agent_id: Option<&str>,
    to: Option<&str>,
    request_id: &str,
) -> ClaudeRequestRoute {
    let mut input = json!({ "tool_name": tool_name });
    if let Some(agent_id) = agent_id {
        input["agent_id"] = agent_id.into();
    }
    if let Some(to) = to {
        input["tool_input"] = json!({ "to": to, "message": "go on" });
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
    } = route_pre_tool_call(pauses, "Agent", agent_id, None, request_id)
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
// timed one denied). Mutations: in `answer_background_work_check`, `untimed_answer` always
// `Pass`; in `ClaudeShellCall::of`, `timeout.is_none()` to `is_some()` or the condition
// dropped.
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
#[tokio::test]
async fn the_background_work_hook_denies_background_work_and_untimed_background_calls(
    #[case] tool_input: serde_json::Value,
    #[case] expected: Expected,
) {
    let shell_lines = ShellLineReadingBound::new(4096);
    let background_work = Arc::new(BackgroundWorkForms::of_providers(PROVIDERS));
    let tool_input: HookToolInput = serde_json::from_value(tool_input).expect("a tool input");

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
        route_pre_tool_call(&pauses, "Bash", None, None, "r2"),
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
    let ClaudeRequestRoute::Held { helper } =
        route_start(&pauses, &posture, Some("helper-a"), "r2").await
    else {
        panic!("a paused helper's helper start is held");
    };
    assert_eq!(
        helper,
        Some(ClaudeHeldHelper {
            agent_id: "helper-a".to_owned(),
            has_taken_effect: true,
        })
    );
}

const CALLER: &str = "helper-caller";
const TARGET: &str = "helper-target";

/// The session's agent tree as one stored helper whose newest own run stopped with its
/// trigger, or a read that fails.
struct StoredStop(Result<Option<StopTrigger>, &'static str>);

type Lookup<'a> = BoxFuture<'a, Result<Option<AgentTreeHelper>, Box<dyn Error + Send + Sync>>>;

impl AgentTreeLookup for StoredStop {
    fn helper_by_subagent_id(
        &self,
        _session_id: SessionId,
        _provider_name: ProviderId,
        subagent_id: String,
    ) -> Lookup<'_> {
        let found = self.0.map(|trigger| {
            Some(AgentTreeHelper {
                child_handle: ChildHandle::new("child-1".to_owned()).expect("a handle"),
                subagent_id,
                provider_path: None,
                own_run_id: RunId::new("0190a5d2-7c1e-7d3a-9b2f-4c8e6a1f3b5e")
                    .expect("a valid run id"),
                own_run_state: if trigger.is_some() {
                    RunState::Stopped
                } else {
                    RunState::Running
                },
                own_run_stop_trigger: trigger,
            })
        });
        async move { found.map_err(Into::into) }.boxed()
    }

    fn helper_by_name(&self, _session_id: SessionId, _name: String) -> Lookup<'_> {
        async { Ok(None) }.boxed()
    }

    fn helper_by_provider_path(&self, _session_id: SessionId, _path: String) -> Lookup<'_> {
        async { Ok(None) }.boxed()
    }
}

/// Who sends the message: the lead, or a helper paused or stopped at its token limit.
#[derive(Clone, Copy, Debug)]
enum Caller {
    Lead,
    PausedHelper,
    StoppedHelper,
}

/// What memory holds of the target.
#[derive(Clone, Copy, Debug)]
enum Target {
    Running,
    Paused,
    Interrupted,
    StoppedWithAll,
    StoppedAtLimit,
}

/// The answer a message expects: none, or the sentence it is denied with.
#[derive(Clone, Copy, Debug)]
enum Denial {
    None,
    Held,
    StopAll,
    Unread,
    CallerAtLimit,
}

const UNREAD_CAUSE: &str = "the database is locked";

// Killed by the target checked after the caller's hold (a paused caller's message held, not
// denied), by the stored stop never read (a stop-all forgotten at a restart passing), by a
// stored token-limit stop or one in memory read as final, by `StopAll`'s sentence swapped
// for the held one, by a running target denied, by a failed read passing, and by a stopped
// caller answered with the target's sentence.
#[rstest]
#[case::lead_to_a_paused_helper(Caller::Lead, Target::Paused, Ok(None), Denial::Held)]
#[case::lead_to_an_interrupted_helper(Caller::Lead, Target::Interrupted, Ok(None), Denial::Held)]
#[case::paused_helper_to_a_paused_helper(
    Caller::PausedHelper,
    Target::Paused,
    Ok(None),
    Denial::Held
)]
#[case::lead_to_a_running_helper(Caller::Lead, Target::Running, Ok(None), Denial::None)]
#[case::lead_to_a_helper_stopped_with_all(
    Caller::Lead,
    Target::StoppedWithAll,
    Ok(None),
    Denial::StopAll
)]
#[case::lead_to_a_stored_stop_all(
    Caller::Lead,
    Target::Running,
    Ok(Some(StopTrigger::StopAll)),
    Denial::StopAll
)]
#[case::lead_to_a_stored_token_limit_stop(
    Caller::Lead,
    Target::Running,
    Ok(Some(StopTrigger::TokenLimit)),
    Denial::None
)]
#[case::lead_to_a_helper_stopped_at_its_limit(
    Caller::Lead,
    Target::StoppedAtLimit,
    Ok(None),
    Denial::None
)]
#[case::lead_when_the_read_fails(Caller::Lead, Target::Running, Err(UNREAD_CAUSE), Denial::Unread)]
#[case::stopped_helper_to_a_paused_helper(
    Caller::StoppedHelper,
    Target::Paused,
    Ok(None),
    Denial::CallerAtLimit
)]
#[tokio::test]
async fn a_message_aimed_at_a_held_or_finally_stopped_helper_is_denied(
    #[case] caller: Caller,
    #[case] target: Target,
    #[case] stored: Result<Option<StopTrigger>, &'static str>,
    #[case] denial: Denial,
) {
    let session_id = fixed_session_id();
    let pauses = Mutex::new(ClaudeRunPauses::default());
    {
        let mut held = lock(&pauses);
        match caller {
            Caller::Lead => {}
            Caller::PausedHelper => held.pause_helper(&session_id, CALLER),
            Caller::StoppedHelper => {
                held.stop_helper(session_id, CALLER, HelperStopReason::TokenLimit);
            }
        }
        match target {
            Target::Running => {}
            Target::Paused => held.pause_helper(&session_id, TARGET),
            Target::Interrupted => held.hold_interrupted_helper(&session_id, TARGET),
            Target::StoppedWithAll => {
                held.stop_helper(session_id, TARGET, HelperStopReason::StopAll);
            }
            Target::StoppedAtLimit => {
                held.stop_helper(session_id, TARGET, HelperStopReason::TokenLimit);
            }
        }
    }
    let agent_id = match caller {
        Caller::Lead => None,
        Caller::PausedHelper | Caller::StoppedHelper => Some(CALLER),
    };
    let ClaudeRequestRoute::CheckMessageTarget {
        request_id,
        agent_id,
        to,
    } = route_pre_tool_call(&pauses, "SendMessage", agent_id, Some(TARGET), "r1")
    else {
        panic!("a message naming its recipient goes to the check");
    };

    let route = route_message_target(
        Some(Arc::new(StoredStop(stored))),
        &pauses,
        &session_id,
        request_id,
        agent_id,
        to,
    )
    .await;

    let ClaudeRequestRoute::Answer { request_id, answer } = route else {
        panic!("the message is answered at once, never held: {route:?}");
    };
    assert_eq!(request_id, "r1");
    let reason = match denial {
        Denial::None => None,
        Denial::Held => Some(HELD_TARGET_REASON.to_owned()),
        Denial::StopAll => Some(HelperStopReason::StopAll.sentence()),
        Denial::Unread => Some(target_unread_reason(UNREAD_CAUSE)),
        Denial::CallerAtLimit => Some(HelperStopReason::TokenLimit.sentence()),
    };
    let expected = reason.map_or(ClaudeHookAnswer::Pass, |reason| ClaudeHookAnswer::Deny {
        reason,
    });
    assert_eq!(answer, expected);
}
