use std::error::Error;
use std::path::Path;
use std::sync::{Arc, Mutex};

use futures::FutureExt;
use futures::future::BoxFuture;
use rstest::rstest;
use serde_json::value::RawValue;
use serde_json::{Value, json};
use sidekicks_contracts::agent::tree::ChildHandle;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::control::StopTrigger;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;
use sidekicks_std::error_description::describe_error;
use sidekicks_std::mutex_lock::lock;

use super::{
    ClaudeHeldHelper, ClaudeRequestRoute, ClaudeShellCall, HookToolInput,
    UNTIMED_BACKGROUND_REASON, answer_background_work_check, helper_start_refused_reason,
    route_claude_request, route_helper_start, route_helper_wake, route_message_target,
};
use crate::background_work::BackgroundWorkForms;
use crate::driver::PROVIDERS;
use crate::driver::claude::hooks::helper_limit::{ClaudeHelperLimit, OneHelperAtOnce};
use crate::driver::claude::hooks::helper_steers::ClaudeHelperSteers;
use crate::driver::claude::hooks::pause::{ClaudeHookAnswer, ClaudeRunPauses};
use crate::driver::claude::hooks::registration::ClaudeHookCallback as RegisteredHook;
use crate::driver::claude::session::scripted::channel::ScriptedWrite;
use crate::driver::claude::session::scripted::driver::create_params;
use crate::driver::claude::session::scripted::{ScriptedSession, settle};
use crate::driver::claude::session::transport::inbound::{
    ClaudeHookCallback, ClaudeInboundRequest, ClaudeInboundRequestBody, ClaudeInboundRequestEvent,
};
use crate::driver::hook_pauses::{HELD_TARGET_REASON, PAUSED_REASON};
use crate::driver::run_control::HelperStopReason;
use crate::driver::session_control::{CreateSessionParams, SubagentPolicy};
use crate::driver::session_messages::target_unread_reason;
use crate::driver::test_registry::fixed_session_id;
use crate::port::agent_tree_lookup::{AgentTreeHelper, AgentTreeLookup};
use crate::run::posture::{compose_execution_posture, resolve_posture};

mod command_windows;
mod edit_copies;

// Routes one pre-tool callback of `hook` for `tool_name`, called by the helper `agent_id` or the
// lead, its input naming the recipient `to` when given; the call's id is the request's.
fn route_hook_call(
    hook: RegisteredHook,
    pauses: &Mutex<ClaudeRunPauses>,
    helpers: &Mutex<ClaudeHelperLimit>,
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
    route_hook_input(hook, pauses, helpers, &input, request_id)
}

// Routes one callback of `hook` whose whole input is `input`; the callback names no tool call of
// its own.
fn route_hook_input(
    hook: RegisteredHook,
    pauses: &Mutex<ClaudeRunPauses>,
    helpers: &Mutex<ClaudeHelperLimit>,
    input: &Value,
    request_id: &str,
) -> ClaudeRequestRoute {
    let event = ClaudeInboundRequestEvent::Request(ClaudeInboundRequest {
        request_id: request_id.to_owned(),
        body: ClaudeInboundRequestBody::HookCallback(ClaudeHookCallback {
            callback_id: Some(hook.id().to_owned()),
            tool_use_id: None,
            input: Some(RawValue::from_string(input.to_string()).expect("a JSON input")),
        }),
    });
    route_claude_request(
        event,
        &fixed_session_id(),
        Some(PermissionLevel::Sandboxed),
        &mut lock(pauses),
        &mut lock(helpers),
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
        ..
    } = route_hook_call(
        RegisteredHook::PauseBeforeTool,
        pauses,
        &Mutex::default(),
        "Agent",
        agent_id,
        None,
        request_id,
    )
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
        route_hook_call(
            RegisteredHook::PauseBeforeTool,
            &pauses,
            &Mutex::default(),
            "Bash",
            None,
            None,
            "r2",
        ),
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

/// The session's agent tree as one stored helper, [`TARGET`], with its newest own run's state and
/// stop trigger, or a read that fails; any other id finds none.
struct StoredTarget(Result<(RunState, Option<StopTrigger>), &'static str>);

/// [`TARGET`] stored running.
const STORED_RUNNING: Result<(RunState, Option<StopTrigger>), &str> = Ok((RunState::Running, None));

/// [`TARGET`] stored completed.
const ENDED: Result<(RunState, Option<StopTrigger>), &str> = Ok((RunState::Completed, None));

type Lookup<'a> = BoxFuture<'a, Result<Option<AgentTreeHelper>, Box<dyn Error + Send + Sync>>>;

impl AgentTreeLookup for StoredTarget {
    fn helper_by_subagent_id(
        &self,
        _session_id: SessionId,
        _provider_name: ProviderId,
        subagent_id: String,
    ) -> Lookup<'_> {
        let found = self.0.map(|(state, trigger)| {
            (subagent_id == TARGET).then(|| AgentTreeHelper {
                child_handle: ChildHandle::new("child-1".to_owned()).expect("a handle"),
                subagent_id,
                provider_path: None,
                own_run_id: RunId::new("0190a5d2-7c1e-7d3a-9b2f-4c8e6a1f3b5e")
                    .expect("a valid run id"),
                own_run_state: state,
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

// Puts what memory holds of [`TARGET`] in place.
fn hold_target(pauses: &mut ClaudeRunPauses, target: Target) {
    let session_id = fixed_session_id();
    match target {
        Target::Running => {}
        Target::Paused => pauses.pause_helper(&session_id, TARGET),
        Target::Interrupted => pauses.hold_interrupted_helper(&session_id, TARGET),
        Target::StoppedWithAll => {
            pauses.stop_helper(session_id, TARGET, HelperStopReason::StopAll);
        }
        Target::StoppedAtLimit => {
            pauses.stop_helper(session_id, TARGET, HelperStopReason::TokenLimit);
        }
    }
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
#[case::lead_to_a_paused_helper(Caller::Lead, Target::Paused, STORED_RUNNING, Denial::Held)]
#[case::lead_to_an_interrupted_helper(
    Caller::Lead,
    Target::Interrupted,
    STORED_RUNNING,
    Denial::Held
)]
#[case::paused_helper_to_a_paused_helper(
    Caller::PausedHelper,
    Target::Paused,
    STORED_RUNNING,
    Denial::Held
)]
#[case::lead_to_a_running_helper(Caller::Lead, Target::Running, STORED_RUNNING, Denial::None)]
#[case::lead_to_a_helper_stopped_with_all(
    Caller::Lead,
    Target::StoppedWithAll,
    STORED_RUNNING,
    Denial::StopAll
)]
#[case::lead_to_a_stored_stop_all(
    Caller::Lead,
    Target::Running,
    Ok((RunState::Stopped, Some(StopTrigger::StopAll))),
    Denial::StopAll
)]
#[case::lead_to_a_stored_token_limit_stop(
    Caller::Lead,
    Target::Running,
    Ok((RunState::Stopped, Some(StopTrigger::TokenLimit))),
    Denial::None
)]
#[case::lead_to_a_helper_stopped_at_its_limit(
    Caller::Lead,
    Target::StoppedAtLimit,
    STORED_RUNNING,
    Denial::None
)]
#[case::lead_when_the_read_fails(Caller::Lead, Target::Running, Err(UNREAD_CAUSE), Denial::Unread)]
#[case::stopped_helper_to_a_paused_helper(
    Caller::StoppedHelper,
    Target::Paused,
    STORED_RUNNING,
    Denial::CallerAtLimit
)]
#[tokio::test]
async fn a_message_aimed_at_a_held_or_finally_stopped_helper_is_denied(
    #[case] caller: Caller,
    #[case] target: Target,
    #[case] stored: Result<(RunState, Option<StopTrigger>), &'static str>,
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
        hold_target(&mut held, target);
    }
    let agent_id = match caller {
        Caller::Lead => None,
        Caller::PausedHelper | Caller::StoppedHelper => Some(CALLER),
    };
    let ClaudeRequestRoute::CheckMessageTarget {
        request_id,
        agent_id,
        to,
    } = route_hook_call(
        RegisteredHook::PauseBeforeTool,
        &pauses,
        &Mutex::default(),
        "SendMessage",
        agent_id,
        Some(TARGET),
        "r1",
    )
    else {
        panic!("a message naming its recipient goes to the check");
    };

    let route = route_message_target(
        Some(Arc::new(StoredTarget(stored))),
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

/// How the helper limit answers a message call: a pass, a hold, or the failed read's denial.
#[derive(Clone, Copy, Debug)]
enum WakeAnswer {
    Pass,
    Held,
    Unread,
}

// Routes one message call `request_id` aimed at `to` through the helper-limit hook and, where it
// goes to the wake check, through that check over `tree`, with memory holding `target` as
// `pauses` says, as the session's task does.
async fn route_wake(
    one: &OneHelperAtOnce,
    target: Target,
    tree: Option<Result<(RunState, Option<StopTrigger>), &'static str>>,
    to: Option<&str>,
    request_id: &str,
) -> ClaudeRequestRoute {
    let pauses = Mutex::new(ClaudeRunPauses::default());
    hold_target(&mut lock(&pauses), target);
    let route = route_hook_call(
        RegisteredHook::HelperLimit,
        &pauses,
        &one.limit,
        "SendMessage",
        None,
        to,
        request_id,
    );
    let ClaudeRequestRoute::CheckHelperWake {
        request_id,
        agent_id,
        tool_use_id,
        to,
    } = route
    else {
        return route;
    };
    let lookup = tree.map(|stored| Arc::new(StoredTarget(stored)) as Arc<dyn AgentTreeLookup>);
    route_helper_wake(
        lookup,
        &pauses,
        &one.limit,
        &fixed_session_id(),
        request_id,
        agent_id.as_deref(),
        &tool_use_id,
        &to,
    )
    .await
}

// Admits the helper start `request_id` through the helper-limit hook.
fn admit_start(one: &OneHelperAtOnce, request_id: &str) {
    let pauses = Mutex::new(ClaudeRunPauses::default());
    assert!(matches!(
        route_hook_call(
            RegisteredHook::HelperLimit,
            &pauses,
            &one.limit,
            "Agent",
            None,
            None,
            request_id,
        ),
        ClaudeRequestRoute::Answer {
            answer: ClaudeHookAnswer::Pass,
            ..
        }
    ));
}

// With the one slot taken by a running helper, a message waking an ended helper waits like a new
// start, and one the message-target check denies wakes nothing and passes uncounted. Killed by the
// recipient unchecked (every message call held, or none), by the wake not counted (an ended
// helper's wake passed), by a running helper's wake held, by a call with no recipient or a helper
// the tree does not hold held, by a failed read passing, and by counting a message to a helper
// stopped with every other agent, in memory or stored, or to one a pause or an interrupt holds.
#[rstest]
#[case::completed_helper(Target::Running, Some(ENDED), Some(TARGET), WakeAnswer::Held)]
#[case::interrupted_helper(
    Target::Running,
    Some(Ok((RunState::Interrupted, None))),
    Some(TARGET),
    WakeAnswer::Held
)]
#[case::running_helper(Target::Running, Some(STORED_RUNNING), Some(TARGET), WakeAnswer::Pass)]
#[case::helper_the_tree_does_not_hold(
    Target::Running,
    Some(ENDED),
    Some("helper-unknown"),
    WakeAnswer::Pass
)]
#[case::no_tree_registered(Target::Running, None, Some(TARGET), WakeAnswer::Pass)]
#[case::no_recipient(Target::Running, Some(ENDED), None, WakeAnswer::Pass)]
#[case::failed_read(
    Target::Running,
    Some(Err(UNREAD_CAUSE)),
    Some(TARGET),
    WakeAnswer::Unread
)]
#[case::interrupted_helper_held(
    Target::Interrupted,
    Some(Ok((RunState::Interrupted, None))),
    Some(TARGET),
    WakeAnswer::Pass
)]
#[case::paused_helper(Target::Paused, Some(ENDED), Some(TARGET), WakeAnswer::Pass)]
#[case::helper_stopped_with_all(
    Target::StoppedWithAll,
    Some(ENDED),
    Some(TARGET),
    WakeAnswer::Pass
)]
#[case::stored_stop_all(
    Target::Running,
    Some(Ok((RunState::Stopped, Some(StopTrigger::StopAll)))),
    Some(TARGET),
    WakeAnswer::Pass
)]
#[case::stored_token_limit_stop(
    Target::Running,
    Some(Ok((RunState::Stopped, Some(StopTrigger::TokenLimit)))),
    Some(TARGET),
    WakeAnswer::Held
)]
#[tokio::test]
async fn a_message_waking_an_ended_helper_counts_against_the_limit(
    #[case] target: Target,
    #[case] tree: Option<Result<(RunState, Option<StopTrigger>), &'static str>>,
    #[case] to: Option<&str>,
    #[case] expected: WakeAnswer,
) {
    let one = OneHelperAtOnce::new();
    admit_start(&one, "start-1");
    assert_eq!(
        one.start_helper("helper-1", "start-1"),
        Vec::<String>::new()
    );

    let route = route_wake(&one, target, tree, to, "wake-1").await;

    match (expected, &route) {
        (
            WakeAnswer::Pass,
            ClaudeRequestRoute::Answer {
                request_id,
                answer: ClaudeHookAnswer::Pass,
            },
        ) if request_id == "wake-1" => {}
        (WakeAnswer::Held, ClaudeRequestRoute::Held { helper: None }) => {}
        (
            WakeAnswer::Unread,
            ClaudeRequestRoute::Answer {
                request_id,
                answer: ClaudeHookAnswer::Deny { reason },
            },
        ) if request_id == "wake-1" && *reason == target_unread_reason(UNREAD_CAUSE) => {}
        (expected, route) => panic!("expected {expected:?}, routed {route:?}"),
    }
}

// [`TARGET`] as `stored` holds it, read while the person's interrupt holds it in `pauses`.
struct HeldDuringRead(Arc<Mutex<ClaudeRunPauses>>, StoredTarget);

impl AgentTreeLookup for HeldDuringRead {
    fn helper_by_subagent_id(
        &self,
        session_id: SessionId,
        provider_name: ProviderId,
        subagent_id: String,
    ) -> Lookup<'_> {
        hold_target(&mut lock(&self.0), Target::Interrupted);
        self.1
            .helper_by_subagent_id(session_id, provider_name, subagent_id)
    }

    fn helper_by_name(&self, session_id: SessionId, name: String) -> Lookup<'_> {
        self.1.helper_by_name(session_id, name)
    }

    fn helper_by_provider_path(&self, session_id: SessionId, path: String) -> Lookup<'_> {
        self.1.helper_by_provider_path(session_id, path)
    }
}

// With the one slot taken, an interrupt holding the target while its read is in flight lets the
// wake pass uncounted. Killed by counting the wake on the read alone, with no recheck of the hold
// after it (the wake is held).
#[tokio::test]
async fn a_wake_whose_target_is_held_during_its_read_passes_uncounted() {
    let one = OneHelperAtOnce::new();
    admit_start(&one, "start-1");
    assert_eq!(
        one.start_helper("helper-1", "start-1"),
        Vec::<String>::new()
    );
    let pauses = Arc::new(Mutex::new(ClaudeRunPauses::default()));
    let stored = StoredTarget(Ok((RunState::Interrupted, None)));
    let lookup = Arc::new(HeldDuringRead(Arc::clone(&pauses), stored));

    let route = route_helper_wake(
        Some(lookup),
        &pauses,
        &one.limit,
        &fixed_session_id(),
        "wake-1".to_owned(),
        None,
        "call-wake",
        TARGET,
    )
    .await;

    assert!(
        matches!(
            &route,
            ClaudeRequestRoute::Answer {
                answer: ClaudeHookAnswer::Pass,
                ..
            }
        ),
        "{route:?}"
    );
}

// Killed by release out of arrival order (the later start freed before the wake), by a held wake
// never released, and by an admitted wake left counted after its helper's resume started and
// ended.
#[tokio::test]
async fn a_held_wake_is_released_before_a_later_held_start_as_helpers_end() {
    let one = OneHelperAtOnce::new();
    admit_start(&one, "start-1");
    assert_eq!(
        one.start_helper("helper-1", "start-1"),
        Vec::<String>::new()
    );
    assert!(matches!(
        route_wake(&one, Target::Running, Some(ENDED), Some(TARGET), "wake-1").await,
        ClaudeRequestRoute::Held { helper: None }
    ));
    let pauses = Mutex::new(ClaudeRunPauses::default());
    assert!(matches!(
        route_hook_call(
            RegisteredHook::HelperLimit,
            &pauses,
            &one.limit,
            "Agent",
            None,
            None,
            "start-2",
        ),
        ClaudeRequestRoute::Held { helper: None }
    ));

    assert_eq!(one.end_helper("helper-1", "start-1"), ["wake-1"]);
    // The woken helper's resume names the message call as its parent.
    assert_eq!(one.start_helper(TARGET, "wake-1"), Vec::<String>::new());
    assert_eq!(one.end_helper(TARGET, "wake-1"), ["start-2"]);
}

// A pre-tool callback of the hook `callback_id` for the lead's call `call_id` of `tool_name`,
// aimed at `to` where one is named.
fn lead_tool_callback(
    callback_id: &str,
    tool_name: &str,
    call_id: &str,
    to: Option<&str>,
) -> Value {
    let mut input = json!({
        "hook_event_name": "PreToolUse",
        "tool_name": tool_name,
        "tool_use_id": call_id,
    });
    if let Some(to) = to {
        input["tool_input"] = json!({ "to": to, "message": "go on" });
    }
    json!({"subtype": "hook_callback", "callback_id": callback_id, "input": input})
}

// The answers the session's process was written, by request id, in order.
fn written_answers(session: &ScriptedSession) -> Vec<(String, Value)> {
    session
        .channel
        .writes()
        .into_iter()
        .filter_map(|write| match write {
            ScriptedWrite::Answer { request_id, answer } => Some((request_id, answer)),
            ScriptedWrite::Control(_) | ScriptedWrite::User(_) | ScriptedWrite::Terminate => None,
        })
        .collect()
}

fn answer_value(answer: &ClaudeHookAnswer) -> Value {
    serde_json::to_value(answer).expect("an answer serializes")
}

// Both of the daemon's pre-tool hooks answer each call: a call the pause hook denies is let
// through by the helper limit, which counts it only until the call is answered, and one aimed at
// a helper stopped with every other agent is never counted. One admitted call keeps one entry, and
// none is left once its denied call is answered with no helper started. Killed by the limit
// counting the message to the stopped helper (an entry left, the later start held for good), and
// by an admitted call answered with no start left counted (the held start never freed).
#[tokio::test(start_paused = true)]
async fn a_call_the_pause_hook_denies_keeps_no_helper_slot_once_answered() {
    let session = ScriptedSession::created_with(|session_id| CreateSessionParams {
        subagent_policy: Some(SubagentPolicy::Enabled {
            helpers_at_once: Some(SafeInt::new(1).expect("1 is a safe integer")),
            definitions: Vec::new(),
        }),
        ..create_params(session_id)
    })
    .await;
    session
        .parts
        .establishment
        .task_services
        .agent_tree_lookup
        .register(Arc::new(StoredTarget(ENDED)) as Arc<dyn AgentTreeLookup>)
        .expect("the agent tree registers once");
    let session_id = session.session_id;
    let admitted = || lock(&session.parts.establishment.helpers).admitted_start_count(&session_id);
    let lead_run = session.hold_lead_turn("lead");
    let pauses = &session.parts.run_controls.pauses;
    lock(pauses).stop_helper(session_id, TARGET, HelperStopReason::StopAll);

    for callback_id in ["sidekicks-pause-before-tool", "sidekicks-helper-limit"] {
        let request_id = format!("{callback_id}/send-1");
        let callback = lead_tool_callback(callback_id, "SendMessage", "send-1", Some(TARGET));
        session.request(&request_id, &callback);
    }
    settle().await;
    assert_eq!(admitted(), 0);

    lock(pauses).pause_lead(&session_id, &lead_run);
    for callback_id in ["sidekicks-pause-before-tool", "sidekicks-helper-limit"] {
        let request_id = format!("{callback_id}/start-1");
        session.request(
            &request_id,
            &lead_tool_callback(callback_id, "Agent", "start-1", None),
        );
    }
    let held_start = lead_tool_callback("sidekicks-helper-limit", "Agent", "start-2", None);
    session.request("sidekicks-helper-limit/start-2", &held_start);
    settle().await;
    assert_eq!(admitted(), 1);
    let deny = |reason: String| answer_value(&ClaudeHookAnswer::Deny { reason });
    let pass = answer_value(&ClaudeHookAnswer::Pass);
    let mut expected = vec![
        (
            "sidekicks-pause-before-tool/send-1".to_owned(),
            deny(HelperStopReason::StopAll.sentence()),
        ),
        ("sidekicks-helper-limit/send-1".to_owned(), pass.clone()),
        (
            "sidekicks-pause-before-tool/start-1".to_owned(),
            deny(PAUSED_REASON.to_owned()),
        ),
        ("sidekicks-helper-limit/start-1".to_owned(), pass.clone()),
    ];
    assert_eq!(written_answers(&session), expected);

    // Claude Code answers the denied call with its error, and no helper starts.
    session.frame(&json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": "start-1",
                "content": PAUSED_REASON,
                "is_error": true,
            }],
        },
    }));
    settle().await;

    expected.push(("sidekicks-helper-limit/start-2".to_owned(), pass));
    assert_eq!(written_answers(&session), expected);
    assert_eq!(
        admitted(),
        1,
        "the freed start is the one admitted call left"
    );
}
