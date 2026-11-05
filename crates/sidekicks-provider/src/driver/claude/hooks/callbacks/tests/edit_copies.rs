//! The pre-tool hook of a call that changes a file: routed to its copy only when the pause lets
//! it run, held with its edit by a helper's pause, and answered only once the copy is kept.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_std::mutex_lock::lock;

use super::{answer_value, route_hook_input};
use crate::driver::claude::hooks::callbacks::{
    ClaudeRequestRoute, ClaudeToolCapture, answer_released_callbacks,
};
use crate::driver::claude::hooks::command_capture::ClaudeCommandWindows;
use crate::driver::claude::hooks::edit_checkpoint::tests::{GatedEditCheckpoint, is_answered};
use crate::driver::claude::hooks::pause::{ClaudeHookAnswer, ClaudeRunPauses};
use crate::driver::claude::hooks::registration::ClaudeHookCallback as RegisteredHook;
use crate::driver::claude::session::scripted::channel::ScriptedChannel;
use crate::driver::run_control::HelperStopReason;
use crate::driver::test_registry::fixed_session_id;
use crate::port::command_capture::unregistered_capture;
use crate::port::edit_checkpoint::{EditCheckpoint, EditCheckpointRequest};
use crate::process_identity::TEST_PROVIDER_PROCESS;

// A pre-tool hook's input for a `Write` of `path` by the helper `agent_id` or the lead, by the
// call `tool_use_id`.
fn write_input(agent_id: Option<&str>, path: &Path, tool_use_id: &str) -> Value {
    let mut input = json!({
        "tool_name": "Write",
        "tool_use_id": tool_use_id,
        "tool_input": { "file_path": path.to_string_lossy(), "content": "x" },
    });
    if let Some(agent_id) = agent_id {
        input["agent_id"] = agent_id.into();
    }
    input
}

// The edit of `path` by the call `tool_use_id` in the fixed session.
fn edit_of(path: PathBuf, tool_use_id: &str) -> EditCheckpointRequest {
    EditCheckpointRequest {
        session_id: fixed_session_id(),
        path,
        tool_call_id: Some(ToolCallId::new(tool_use_id.to_owned()).expect("a call id")),
    }
}

/// How a case's file is sent: absolute, or relative to the hook's folder.
#[derive(Clone, Copy, Debug)]
enum SentPath {
    Absolute,
    Relative,
}

// Killed by `notebook_path` left unread, a read tool routed to a copy, a relative path passed on
// unjoined, and the tool call dropped.
#[rstest]
#[case::write_with_an_absolute_file("Write", "file_path", SentPath::Absolute, true, true)]
#[case::notebook_with_an_absolute_file(
    "NotebookEdit",
    "notebook_path",
    SentPath::Absolute,
    true,
    true
)]
#[case::notebook_with_a_relative_file(
    "NotebookEdit",
    "notebook_path",
    SentPath::Relative,
    true,
    true
)]
#[case::relative_file_with_no_folder("Write", "file_path", SentPath::Relative, false, false)]
#[case::read("Read", "file_path", SentPath::Absolute, true, false)]
fn an_edit_call_routes_to_its_copy(
    #[case] tool_name: &str,
    #[case] member: &str,
    #[case] sent: SentPath,
    #[case] has_folder: bool,
    #[case] is_copied: bool,
) {
    let folder = tempfile::tempdir().expect("a temporary folder");
    let relative = Path::new("notes").join("plan.ipynb");
    let absolute = folder.path().join(&relative);
    let sent_path = match sent {
        SentPath::Absolute => &absolute,
        SentPath::Relative => &relative,
    };
    let mut input = json!({
        "tool_name": tool_name,
        "tool_use_id": "toolu_1",
        "tool_input": {},
    });
    input["tool_input"][member] = sent_path.to_string_lossy().into();
    if has_folder {
        input["cwd"] = folder.path().to_string_lossy().into();
    }

    let route = route_hook_input(
        RegisteredHook::PauseBeforeTool,
        &Mutex::default(),
        &Mutex::default(),
        &input,
        "r1",
    );

    match (is_copied, route) {
        (
            true,
            ClaudeRequestRoute::CaptureBeforeTool {
                request_id,
                capture: ClaudeToolCapture::Edit(edit),
            },
        ) => {
            assert_eq!(request_id, "r1");
            assert_eq!(edit, edit_of(absolute, "toolu_1"));
        }
        (
            false,
            ClaudeRequestRoute::Answer {
                request_id,
                answer: ClaudeHookAnswer::Pass,
            },
        ) if request_id == "r1" => {}
        (is_copied, route) => panic!("expected a copy: {is_copied}, routed {route:?}"),
    }
}

// Killed by the edit read ahead of the pause's answer.
#[test]
fn a_paused_or_stopped_callers_edit_is_denied_with_no_copy() {
    let folder = tempfile::tempdir().expect("a temporary folder");
    let path = folder.path().join("main.rs");
    let session_id = fixed_session_id();
    let run_id = RunId::new("0190a5d2-7c1e-7d3a-9b2f-4c8e6a1f3b5e").expect("a valid run id");
    let pauses = Mutex::new(ClaudeRunPauses::default());
    lock(&pauses).pause_lead(&session_id, &run_id);
    lock(&pauses).stop_helper(session_id, "helper-1", HelperStopReason::TokenLimit);

    for (agent_id, request_id) in [(None, "r1"), (Some("helper-1"), "r2")] {
        let route = route_hook_input(
            RegisteredHook::PauseBeforeTool,
            &pauses,
            &Mutex::default(),
            &write_input(agent_id, &path, "toolu_1"),
            request_id,
        );
        assert!(
            matches!(
                &route,
                ClaudeRequestRoute::Answer {
                    request_id: answered,
                    answer: ClaudeHookAnswer::Deny { .. },
                } if answered == request_id
            ),
            "expected {request_id} denied, routed {route:?}"
        );
    }
}

// Killed by a copy on a steered deny, the edit dropped at the hold, and the answer written ahead
// of the copy.
#[tokio::test]
async fn a_released_helper_edit_is_copied_before_its_answer_only_when_passed() {
    let folder = tempfile::tempdir().expect("a temporary folder");
    let passed_path = folder.path().join("passed.rs");
    let steered_path = folder.path().join("steered.rs");
    let session_id = fixed_session_id();
    let pauses = Mutex::new(ClaudeRunPauses::default());
    lock(&pauses).pause_helper(&session_id, "helper-a");
    lock(&pauses).pause_helper(&session_id, "helper-b");
    for (agent_id, path, request_id) in [
        ("helper-a", &passed_path, "r-a"),
        ("helper-b", &steered_path, "r-b"),
    ] {
        let route = route_hook_input(
            RegisteredHook::PauseBeforeTool,
            &pauses,
            &Mutex::default(),
            &write_input(Some(agent_id), path, request_id),
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
    let (edit_checkpoint, open) = GatedEditCheckpoint::gated();
    let port: Arc<dyn EditCheckpoint> = Arc::clone(&edit_checkpoint) as _;
    let account = ProviderAccountId::new("account-1".to_owned()).expect("an account id");
    let command_windows = Arc::new(ClaudeCommandWindows::new(unregistered_capture()));

    answer_released_callbacks(
        Some(&port),
        &command_windows,
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
    assert_eq!(edit_checkpoint.requests(), []);

    let answering = tokio::spawn({
        let channel = Arc::clone(&channel);
        async move {
            answer_released_callbacks(
                Some(&port),
                &command_windows,
                &*channel,
                &session_id,
                TEST_PROVIDER_PROCESS,
                &account,
                passed.released,
            )
            .await;
        }
    });
    edit_checkpoint.wait_for_requests(1).await;
    assert!(!is_answered(&channel, "r-a"));

    open.send(()).expect("the copy waits on its gate");
    answering.await.expect("the answers' task ends");
    assert_eq!(channel.answer_to("r-a").await, json!({}));
    assert_eq!(edit_checkpoint.requests(), [edit_of(passed_path, "r-a")]);
}
