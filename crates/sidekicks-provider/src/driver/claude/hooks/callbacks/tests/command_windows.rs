//! The hooks of a command that runs with no wrapper: its pre-tool hook routed to its window only
//! when the pause lets it run, and answered only once the window is open; its post-tool hooks
//! closing the window once, with the call's end.

use std::sync::{Arc, Mutex};

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_platforms::RUNS_COMMAND_WRAPPER;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::watch;

use super::{answer_value, route_hook_input};
use crate::driver::claude::hooks::callbacks::{
    ClaudeRequestRoute, ClaudeToolCapture, answer_released_callbacks,
};
use crate::driver::claude::hooks::command_capture::tests::open_one_window;
use crate::driver::claude::hooks::command_capture::{
    ClaudeCommandLeg, ClaudeCommandTarget, ClaudeCommandWindows,
};
use crate::driver::claude::hooks::edit_checkpoint::tests::is_answered;
use crate::driver::claude::hooks::pause::{ClaudeHookAnswer, ClaudeRunPauses};
use crate::driver::claude::hooks::registration::ClaudeHookCallback as RegisteredHook;
use crate::driver::claude::session::scripted::channel::ScriptedChannel;
use crate::driver::test_registry::fixed_session_id;
use crate::port::command_capture::{
    CaptureCall, CommandWindowEnd, held_capture, next_call, no_call,
};
use crate::process_identity::TEST_PROVIDER_PROCESS;

// A hook's input for a call of `tool_name` with `tool_input` by the helper `agent_id` or the lead,
// by the call `tool_use_id` where one is given.
fn call_input(
    tool_name: &str,
    tool_input: &Value,
    tool_use_id: Option<&str>,
    agent_id: Option<&str>,
) -> Value {
    let mut input = json!({ "tool_name": tool_name, "tool_input": tool_input });
    if let Some(tool_use_id) = tool_use_id {
        input["tool_use_id"] = tool_use_id.into();
    }
    if let Some(agent_id) = agent_id {
        input["agent_id"] = agent_id.into();
    }
    input
}

// The leg a routed `Bash` call takes here, in the background where `is_background` says.
const fn shell_leg(is_background: bool) -> ClaudeCommandLeg {
    if RUNS_COMMAND_WRAPPER {
        ClaudeCommandLeg::Wrapper { is_background }
    } else {
        ClaudeCommandLeg::Hook
    }
}

// Killed by `Bash` given a hook window where the wrapper runs it (two windows for one command), the
// `Bash` call left unnoted, its background flag dropped, a `Monitor` with no command opened, and
// the tool-use id or the helper dropped.
#[rstest]
#[case::powershell(
    "PowerShell",
    json!({ "command": "Get-ChildItem" }),
    true,
    Some(ClaudeCommandLeg::Hook)
)]
#[case::monitor_running_a_command(
    "Monitor",
    json!({ "command": "tail -f app.log" }),
    true,
    Some(ClaudeCommandLeg::Hook)
)]
#[case::monitor_watching_a_socket(
    "Monitor",
    json!({ "ws": { "url": "ws://localhost:9000" } }),
    true,
    None
)]
#[case::read("Read", json!({ "file_path": "/work/notes.md" }), true, None)]
#[case::powershell_with_no_tool_use_id(
    "PowerShell",
    json!({ "command": "Get-ChildItem" }),
    false,
    None
)]
#[case::shell("Bash", json!({ "command": "ls" }), true, Some(shell_leg(false)))]
#[case::shell_in_the_background(
    "Bash",
    json!({ "command": "npm run dev", "run_in_background": true, "timeout": 60000 }),
    true,
    Some(shell_leg(true))
)]
fn a_command_call_routes_to_its_window(
    #[case] tool_name: &str,
    #[case] tool_input: Value,
    #[case] has_tool_use_id: bool,
    #[case] routed_leg: Option<ClaudeCommandLeg>,
) {
    let command = tool_input["command"].as_str().map(str::to_owned);
    let input = call_input(
        tool_name,
        &tool_input,
        has_tool_use_id.then_some("toolu_1"),
        Some("helper-1"),
    );

    let route = route_hook_input(
        RegisteredHook::PauseBeforeTool,
        &Mutex::default(),
        &Mutex::default(),
        &input,
        "r1",
    );

    match (routed_leg, route) {
        (
            Some(leg),
            ClaudeRequestRoute::CaptureBeforeTool {
                request_id,
                capture: ClaudeToolCapture::Command(target),
            },
        ) => {
            assert_eq!(request_id, "r1");
            assert_eq!(
                target,
                ClaudeCommandTarget {
                    tool_use_id: "toolu_1".to_owned(),
                    command: command.expect("a routed call carries its command"),
                    agent_id: Some("helper-1".to_owned()),
                    leg,
                }
            );
        }
        (
            None,
            ClaudeRequestRoute::Answer {
                request_id,
                answer: ClaudeHookAnswer::Pass,
            },
        ) if request_id == "r1" => {}
        (routed_leg, route) => panic!("expected a window: {routed_leg:?}, routed {route:?}"),
    }
}

// Killed by the failure hook routed to no close, the exit code dropped, and a window closed twice.
#[rstest]
#[case::completed(
    RegisteredHook::CaptureAfterTool,
    json!({ "tool_response": { "stdout": "done", "interrupted": false } }),
    CommandWindowEnd::Exited { exit_code: Some(0), signal: None }
)]
#[case::failed_with_an_exit_code(
    RegisteredHook::CaptureAfterFailedTool,
    json!({ "error": "Exit code 2\nerror: no such file" }),
    CommandWindowEnd::Exited { exit_code: Some(2), signal: None }
)]
#[case::failed_with_a_bare_message(
    RegisteredHook::CaptureAfterFailedTool,
    json!({ "error": "the shell could not be started" }),
    CommandWindowEnd::Untold
)]
#[tokio::test]
async fn each_post_hook_closes_its_window_once_with_its_end(
    #[case] hook: RegisteredHook,
    #[case] members: Value,
    #[case] expected: CommandWindowEnd,
) {
    let (_opens, held) = watch::channel(Some(true));
    let (capture, mut called) = held_capture(held);
    let windows = ClaudeCommandWindows::new(capture);
    open_one_window(&windows, &mut called, TEST_PROVIDER_PROCESS, "toolu_1").await;
    let mut input = call_input(
        "PowerShell",
        &json!({ "command": "Get-ChildItem" }),
        Some("toolu_1"),
        None,
    );
    for (name, member) in members.as_object().expect("the hook's members") {
        input[name] = member.clone();
    }

    for (request_id, is_first) in [("r1", true), ("r2", false)] {
        let route = route_hook_input(
            hook,
            &Mutex::default(),
            &Mutex::default(),
            &input,
            request_id,
        );
        let ClaudeRequestRoute::CaptureAfterTool {
            request_id: routed,
            tool_use_id,
            end,
        } = route
        else {
            panic!("a post hook goes to its window, routed {route:?}");
        };
        assert_eq!(routed, request_id);
        // Taken as the session's task takes it.
        let closing = windows.take_post_hook(fixed_session_id(), &tool_use_id, end);
        if let Some(closing) = closing {
            windows.close(closing);
        }
        if is_first {
            assert_eq!(
                next_call(&mut called).await,
                CaptureCall::Close(1, expected)
            );
        } else {
            no_call(&mut called, "a window closed twice").await;
        }
    }
}

// Killed by a window opened for a denied call, the capture dropped at the hold, and the answer
// written ahead of the open.
#[tokio::test]
async fn a_paused_helpers_command_opens_its_window_only_when_passed() {
    let session_id = fixed_session_id();
    let pauses = Mutex::new(ClaudeRunPauses::default());
    lock(&pauses).pause_helper(&session_id, "helper-a");
    lock(&pauses).pause_helper(&session_id, "helper-b");
    for (agent_id, request_id) in [("helper-a", "r-a"), ("helper-b", "r-b")] {
        let input = call_input(
            "PowerShell",
            &json!({ "command": "Get-ChildItem" }),
            Some(request_id),
            Some(agent_id),
        );
        let route = route_hook_input(
            RegisteredHook::PauseBeforeTool,
            &pauses,
            &Mutex::default(),
            &input,
            request_id,
        );
        assert!(
            matches!(route, ClaudeRequestRoute::Held { helper: Some(_) }),
            "routed {route:?}"
        );
    }
    let passed = lock(&pauses).resume_helper(&session_id, "helper-a", None);
    let steered = lock(&pauses).resume_helper(&session_id, "helper-b", Some("check the tests"));
    let channel = Arc::new(ScriptedChannel::default());
    let (opens, held) = watch::channel(None);
    let (capture, mut called) = held_capture(held);
    let windows = Arc::new(ClaudeCommandWindows::new(capture));
    let account = ProviderAccountId::new("account-1".to_owned()).expect("an account id");

    answer_released_callbacks(
        None,
        &windows,
        &*channel,
        &session_id,
        TEST_PROVIDER_PROCESS,
        &account,
        steered.released,
    )
    .await;
    assert_eq!(
        channel.answer_to("r-b").await,
        answer_value(&ClaudeHookAnswer::Deny {
            reason: "check the tests".to_owned(),
        })
    );
    no_call(&mut called, "a window for a denied call").await;

    let answering = tokio::spawn({
        let channel = Arc::clone(&channel);
        let windows = Arc::clone(&windows);
        async move {
            answer_released_callbacks(
                None,
                &windows,
                &*channel,
                &session_id,
                TEST_PROVIDER_PROCESS,
                &account,
                passed.released,
            )
            .await;
        }
    });
    assert_eq!(next_call(&mut called).await, CaptureCall::Open(1));
    assert!(!is_answered(&channel, "r-a"));

    opens.send(Some(true)).expect("the open waits on the test");
    assert_eq!(next_call(&mut called).await, CaptureCall::Began(1, true));
    answering.await.expect("the answers' task ends");
    assert_eq!(channel.answer_to("r-a").await, json!({}));
}
