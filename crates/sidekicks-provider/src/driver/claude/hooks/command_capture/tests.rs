use std::sync::Arc;

use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::{mpsc, watch};

use super::{
    ClaudeCommandEnd, ClaudeCommandOwner, ClaudeCommandTarget, ClaudeCommandWindow,
    ClaudeCommandWindowState, ClaudeCommandWindows, ClaudeHookAnswer,
};
use crate::driver::claude::hooks::edit_checkpoint::tests::is_answered;
use crate::driver::claude::session::scripted::channel::ScriptedChannel;
use crate::driver::test_registry::fixed_session_id;
use crate::port::command_capture::{
    CaptureCall, CommandWindowEnd, CommandWindowStart, held_capture, held_capture_with_starts,
    next_call, no_call, register_held_capture, unregistered_capture,
};
use crate::process_identity::{ProviderProcessIdentity, TEST_PROVIDER_PROCESS};

// The account every test answers as.
fn account() -> ProviderAccountId {
    ProviderAccountId::new("account-1".to_owned()).expect("an account id")
}

// A `PowerShell` call `tool_use_id` by the lead.
fn powershell_target(tool_use_id: &str) -> ClaudeCommandTarget {
    ClaudeCommandTarget {
        tool_use_id: tool_use_id.to_owned(),
        command: "Get-ChildItem".to_owned(),
        agent_id: None,
    }
}

/// Registers on `windows`' own registration, which nothing registered yet, a capture whose
/// opens settle as `opens` sets them, and answers the receiver its calls arrive on. Panics
/// when the registration was already made.
pub(crate) fn register_windows_capture(
    windows: &ClaudeCommandWindows,
    opens: watch::Receiver<Option<bool>>,
) -> mpsc::UnboundedReceiver<CaptureCall> {
    register_held_capture(&windows.capture, opens).0
}

/// Opens the window of the lead's `PowerShell` call `tool_use_id` in the fixed session, by a
/// hook of `process`, through `windows`, whose capture already lets opens through, taking its
/// open and its covered start from `called`.
pub(crate) async fn open_one_window(
    windows: &ClaudeCommandWindows,
    called: &mut mpsc::UnboundedReceiver<CaptureCall>,
    process: ProviderProcessIdentity,
    tool_use_id: &str,
) {
    open_target(windows, called, process, powershell_target(tool_use_id)).await;
}

// Opens `target`'s window as `open_one_window` does.
async fn open_target(
    windows: &ClaudeCommandWindows,
    called: &mut mpsc::UnboundedReceiver<CaptureCall>,
    process: ProviderProcessIdentity,
    target: ClaudeCommandTarget,
) {
    let opening = windows.begin_open(fixed_session_id(), process, target);
    let channel = ScriptedChannel::default();
    windows
        .open_then_answer(opening, &channel, &account(), "r-open".to_owned())
        .await;
    assert!(matches!(next_call(called).await, CaptureCall::Open(_)));
    assert!(matches!(
        next_call(called).await,
        CaptureCall::Began(_, true)
    ));
}

// Killed by the answer written before the open, by `command_began` never told, and by the
// command or the tool call altered on the way.
#[tokio::test]
async fn a_command_is_answered_only_after_its_window_opens() {
    let (opens, held) = watch::channel(None);
    let (capture, mut called, starts) = held_capture_with_starts(held);
    let windows = Arc::new(ClaudeCommandWindows::new(capture));
    let channel = Arc::new(ScriptedChannel::default());
    let opening = windows.begin_open(
        fixed_session_id(),
        TEST_PROVIDER_PROCESS,
        powershell_target("toolu_1"),
    );
    let answering = tokio::spawn({
        let windows = Arc::clone(&windows);
        let channel = Arc::clone(&channel);
        async move {
            windows
                .open_then_answer(opening, &*channel, &account(), "r1".to_owned())
                .await;
        }
    });

    assert_eq!(next_call(&mut called).await, CaptureCall::Open(1));
    assert_eq!(
        *lock(&starts),
        [CommandWindowStart {
            session_id: fixed_session_id(),
            apart_run: None,
            command: "Get-ChildItem".to_owned(),
            tool_call_id: Some(ToolCallId::new("toolu_1".to_owned()).expect("a call id")),
        }]
    );
    no_call(&mut called, "a start told while the open is held").await;
    assert!(!is_answered(&channel, "r1"));

    opens.send(Some(true)).expect("the open waits on the test");
    assert_eq!(next_call(&mut called).await, CaptureCall::Began(1, true));
    answering.await.expect("the answer's task ends");
    assert_eq!(channel.answer_to("r1").await, json!({}));
}

// Killed by a background window closed at its post hook, and by a `Monitor`'s `taskId` left
// unread.
#[rstest]
#[case::shell_in_the_background(Some("bash_1"), None)]
#[case::monitor(None, Some("task_1"))]
#[tokio::test]
async fn a_background_call_stays_open_past_its_post_hook(
    #[case] background_task_id: Option<&str>,
    #[case] task_id: Option<&str>,
) {
    let (_opens, held) = watch::channel(Some(true));
    let (capture, mut called) = held_capture(held);
    let windows = ClaudeCommandWindows::new(capture);
    open_one_window(&windows, &mut called, TEST_PROVIDER_PROCESS, "toolu_1").await;

    let end = ClaudeCommandEnd::read_after_tool(background_task_id, task_id);
    assert_eq!(end, ClaudeCommandEnd::Background);
    assert_eq!(
        windows.take_post_hook(fixed_session_id(), "toolu_1", end),
        None
    );

    no_call(&mut called, "a background window closed").await;
    let kept = lock(&windows.windows);
    assert!(
        matches!(
            kept.get(&(fixed_session_id(), "toolu_1".to_owned())),
            Some(ClaudeCommandWindow {
                process: TEST_PROVIDER_PROCESS,
                agent_id: None,
                state: ClaudeCommandWindowState::Open {
                    has_post_hook: true,
                    is_background: true,
                    ..
                },
            })
        ),
        "kept {kept:?}"
    );
}

/// How a case's open fails.
#[derive(Clone, Copy, Debug)]
enum FailedOpen {
    Failed,
    Unregistered,
}

// Killed by a hook left unanswered on a failed capture, and by an entry kept with no window.
#[rstest]
#[case::failed(FailedOpen::Failed)]
#[case::unregistered(FailedOpen::Unregistered)]
#[tokio::test]
async fn an_open_that_fails_answers_the_hook_with_no_window(#[case] failed: FailedOpen) {
    let (_opens, held) = watch::channel(Some(false));
    let (capture, called) = match failed {
        FailedOpen::Failed => {
            let (capture, called) = held_capture(held);
            (capture, Some(called))
        }
        FailedOpen::Unregistered => (unregistered_capture(), None),
    };
    let windows = ClaudeCommandWindows::new(capture);
    let channel = ScriptedChannel::default();

    let opening = windows.begin_open(
        fixed_session_id(),
        TEST_PROVIDER_PROCESS,
        powershell_target("toolu_1"),
    );
    windows
        .open_then_answer(opening, &channel, &account(), "r1".to_owned())
        .await;

    assert_eq!(
        channel.answer_to("r1").await,
        serde_json::to_value(ClaudeHookAnswer::Pass).expect("an answer serializes")
    );
    if let Some(mut called) = called {
        assert_eq!(next_call(&mut called).await, CaptureCall::Open(1));
        no_call(&mut called, "a start told with no window").await;
    }
    assert!(lock(&windows.windows).is_empty());
}

// A process other than the test's own, as a rewind's fork runs.
const FORK_PROCESS: ProviderProcessIdentity = ProviderProcessIdentity {
    process_id: 8,
    spawn_sequence: 2,
};

// Windows over a capture that lets every open through.
fn open_windows() -> (ClaudeCommandWindows, mpsc::UnboundedReceiver<CaptureCall>) {
    let (_opens, held) = watch::channel(Some(true));
    let (capture, called) = held_capture(held);
    (ClaudeCommandWindows::new(capture), called)
}

// Closes what a closer answered, as the session's task does.
fn close_all(
    windows: &ClaudeCommandWindows,
    closing: impl IntoIterator<Item = (super::CommandWindowId, CommandWindowEnd)>,
) {
    for (window, end) in closing {
        windows.close(window, end);
    }
}

// The window ended untold whose open was the `window`th.
fn untold(window: usize) -> CaptureCall {
    CaptureCall::Close(window, CommandWindowEnd::Untold)
}

// Killed by `Unrun` at a tool result, by a background window closed at its result, and by a
// second close. The result's `is_error` is never read, so one case covers an error or not.
#[rstest]
#[case::no_post_hook(None, Some(CommandWindowEnd::Untold))]
#[case::background(Some(ClaudeCommandEnd::Background), None)]
#[case::post_hook_closed(
    Some(ClaudeCommandEnd::read_after_tool(None, None)),
    Some(CommandWindowEnd::Exited { exit_code: Some(0), signal: None })
)]
#[tokio::test]
async fn a_tool_result_closes_only_a_window_no_post_hook_reached(
    #[case] post_hook: Option<ClaudeCommandEnd>,
    #[case] expected: Option<CommandWindowEnd>,
) {
    let (windows, mut called) = open_windows();
    let session_id = fixed_session_id();
    open_one_window(&windows, &mut called, TEST_PROVIDER_PROCESS, "toolu_1").await;
    if let Some(end) = post_hook {
        close_all(&windows, windows.take_post_hook(session_id, "toolu_1", end));
    }

    for _ in 0..2 {
        close_all(&windows, windows.take_tool_result(session_id, "toolu_1"));
    }

    if let Some(end) = expected {
        assert_eq!(next_call(&mut called).await, CaptureCall::Close(1, end));
    }
    no_call(&mut called, "a window closed again").await;
}

// Killed by a background window left open past its task, and by a foreground exit code lost to
// the task end.
#[tokio::test]
async fn a_task_end_closes_only_a_background_window() {
    let (windows, mut called) = open_windows();
    let session_id = fixed_session_id();
    open_one_window(&windows, &mut called, TEST_PROVIDER_PROCESS, "toolu_1").await;
    open_one_window(&windows, &mut called, TEST_PROVIDER_PROCESS, "toolu_2").await;

    close_all(&windows, windows.take_task_end(session_id, "toolu_1"));
    no_call(&mut called, "a foreground window closed at its task's end").await;
    let exited = ClaudeCommandEnd::read_after_failed_tool(Some("Exit code 3"));
    close_all(
        &windows,
        windows.take_post_hook(session_id, "toolu_1", exited),
    );
    let ended = CommandWindowEnd::Exited {
        exit_code: Some(3),
        signal: None,
    };
    assert_eq!(next_call(&mut called).await, CaptureCall::Close(1, ended));

    let background = ClaudeCommandEnd::Background;
    close_all(
        &windows,
        windows.take_post_hook(session_id, "toolu_2", background),
    );
    close_all(&windows, windows.take_task_end(session_id, "toolu_2"));
    assert_eq!(next_call(&mut called).await, untold(2));
}

// Killed by no backstop, by a background window closed at a turn end, by another helper's
// window closed, and by a process end closing a fork's windows.
#[tokio::test]
async fn the_backstop_closes_what_no_closer_reached() {
    let (windows, mut called) = open_windows();
    let (session_id, process) = (fixed_session_id(), TEST_PROVIDER_PROCESS);
    open_one_window(&windows, &mut called, process, "lead").await;
    open_one_window(&windows, &mut called, process, "lead-background").await;
    for agent_id in ["h1", "h2"] {
        let target = ClaudeCommandTarget {
            agent_id: Some(agent_id.to_owned()),
            ..powershell_target(agent_id)
        };
        open_target(&windows, &mut called, process, target).await;
    }
    open_one_window(&windows, &mut called, FORK_PROCESS, "fork").await;
    let background = ClaudeCommandEnd::Background;
    close_all(
        &windows,
        windows.take_post_hook(session_id, "lead-background", background),
    );

    let lead = ClaudeCommandOwner::Lead;
    close_all(&windows, windows.take_remaining(session_id, process, &lead));
    assert_eq!(next_call(&mut called).await, untold(1));
    no_call(
        &mut called,
        "a turn end closed more than the lead's foreground",
    )
    .await;

    let helper = ClaudeCommandOwner::Helper("h1".to_owned());
    close_all(
        &windows,
        windows.take_remaining(session_id, process, &helper),
    );
    assert_eq!(next_call(&mut called).await, untold(3));
    no_call(&mut called, "a helper's end closed another's").await;

    let ended = ClaudeCommandOwner::Process;
    close_all(
        &windows,
        windows.take_remaining(session_id, process, &ended),
    );
    let mut closed = [next_call(&mut called).await, next_call(&mut called).await];
    closed.sort_by_key(|call| format!("{call:?}"));
    assert_eq!(closed, [untold(2), untold(4)]);
    no_call(&mut called, "a process end closed its fork's window").await;
    assert!(lock(&windows.windows).contains_key(&(session_id, "fork".to_owned())));
}

// Killed by a window left open by a closer that ran while it opened.
#[rstest]
#[case::tool_result(false)]
#[case::process_end(true)]
#[tokio::test]
async fn a_window_opening_at_a_closer_closes_once_open(#[case] is_process_end: bool) {
    let (opens, held) = watch::channel(None);
    let (capture, mut called) = held_capture(held);
    let windows = Arc::new(ClaudeCommandWindows::new(capture));
    let channel = Arc::new(ScriptedChannel::default());
    let (session_id, process) = (fixed_session_id(), TEST_PROVIDER_PROCESS);
    let opening = windows.begin_open(session_id, process, powershell_target("toolu_1"));
    let answering = tokio::spawn({
        let windows = Arc::clone(&windows);
        let channel = Arc::clone(&channel);
        async move {
            windows
                .open_then_answer(opening, &*channel, &account(), "r1".to_owned())
                .await;
        }
    });
    assert_eq!(next_call(&mut called).await, CaptureCall::Open(1));

    let closing = if is_process_end {
        windows.take_remaining(session_id, process, &ClaudeCommandOwner::Process)
    } else {
        windows
            .take_tool_result(session_id, "toolu_1")
            .into_iter()
            .collect()
    };
    assert!(
        closing.is_empty(),
        "a window still opening has none to close"
    );
    opens.send(Some(true)).expect("the open waits on the test");
    answering.await.expect("the answer's task ends");

    assert_eq!(next_call(&mut called).await, CaptureCall::Began(1, true));
    assert_eq!(next_call(&mut called).await, untold(1));
    no_call(&mut called, "a window closed twice").await;
    assert!(is_answered(&channel, "r1"));
    assert!(lock(&windows.windows).is_empty());
}
