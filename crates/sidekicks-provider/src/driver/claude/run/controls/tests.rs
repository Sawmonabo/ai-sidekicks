use serde_json::json;
use sidekicks_contracts::agent::tree::ChildHandle;
use sidekicks_contracts::command::CommandId;
use sidekicks_contracts::provider::driver::capabilities::{CredentialPolicyRef, ExecutionPosture};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::subagent::SubagentId;

use crate::command::helper_background::HelperBackgroundParams;
use crate::driver::claude::hooks::pause::ClaudeHookAnswer;
use crate::driver::claude::session::scripted::channel::{ScriptedAnswer, ScriptedWrite};
use crate::driver::claude::session::scripted::daemon_services::PortCall;
use crate::driver::claude::session::scripted::{
    SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession, binding_id, settle,
};
use crate::driver::run_control::OverrideDenialParams;
use crate::port::running_command_publisher::RunningCommandParams;

fn running_command(session: &ScriptedSession, command_id: &str) -> RunningCommandParams {
    RunningCommandParams {
        session_id: session.session_id,
        binding_id: binding_id("lead"),
        command_id: CommandId::new(command_id.to_owned()).expect("a command id"),
    }
}

// Killed by a stop that answers before Claude Code acknowledged it, so a refused stop reads
// done, by a stop naming anything but the command's task, by an acknowledged stop the lead's
// turn is not told of in the daemon's words, or a refused or cut one it is, by that text
// written into the running turn as no steer, so the next turn opens on it, not the person's
// message, and by a stop whose write was cut leaving the process running.
#[tokio::test(start_paused = true)]
async fn a_stop_answers_only_once_claude_code_acknowledged_it() {
    let session = ScriptedSession::new().await;
    let run_id = session.hold_lead_turn("lead");
    session.frame(&json!({
        "type": "assistant",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "message": {
            "id": "message-1",
            "role": "assistant",
            "content": [
                {"type": "tool_use", "id": "call-1", "name": "Bash",
                 "input": {"command": "sleep 100"}},
            ],
        },
    }));
    session.frame(&json!({
        "type": "system",
        "subtype": "task_started",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "task_id": "task-1",
        "task_type": "local_bash",
        "tool_use_id": "call-1",
    }));
    settle().await;
    let controls = &session.parts.run_controls;
    session.channel.answer("stop_task", ScriptedAnswer::Refused);

    let refused = controls
        .stop_command(&running_command(&session, "task-1"))
        .await;
    let stopped = controls
        .stop_command(&running_command(&session, "task-1"))
        .await;
    session
        .channel
        .answer("stop_task", ScriptedAnswer::WriteCut);
    let cut = controls
        .stop_command(&running_command(&session, "task-1"))
        .await;

    assert!(refused.is_err(), "a refused stop fails");
    assert!(stopped.is_ok(), "an acknowledged stop answers");
    assert!(cut.is_err(), "a cut stop fails");
    assert!(
        session.channel.writes().contains(&ScriptedWrite::Terminate),
        "a cut stop stops the process"
    );
    let requests = session.control_requests_after_start();
    assert_eq!(requests.len(), 3);
    assert!(
        requests
            .iter()
            .all(|request| request["subtype"] == "stop_task" && request["task_id"] == "task-1")
    );
    let told = session.channel.user_frames();
    assert_eq!(told.len(), 1);
    assert!(
        told[0]
            .to_string()
            .contains("The user stopped `sleep 100`.")
    );
    assert_eq!(told[0]["client_composed"], json!(true));
    let mut prompts = session
        .start
        .prompts
        .lock()
        .expect("the prompts' lock holds");
    prompts.record_written(session.session_id, run_id, "person", false);
    assert_eq!(
        prompts.take_turn_opening(session.session_id).as_deref(),
        Some("person")
    );
}

// Killed by moving a command to the background by its task id instead of the tool call that
// started it, which Claude Code's request matches, and by asking for a command it never named.
#[tokio::test(start_paused = true)]
async fn a_command_moves_to_the_background_through_the_call_that_started_it() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    session.frame(&json!({
        "type": "assistant",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "message": {
            "id": "message-1",
            "role": "assistant",
            "content": [
                {"type": "tool_use", "id": "call-b", "name": "Bash",
                 "input": {"command": "sleep 100"}},
            ],
        },
    }));
    session.frame(&json!({
        "type": "system",
        "subtype": "task_started",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "task_id": "task-b",
        "task_type": "local_bash",
        "tool_use_id": "call-b",
        "description": "sleep 100",
    }));
    settle().await;
    let controls = &session.parts.run_controls;

    let unnamed = controls
        .move_command_to_background(&running_command(&session, "task-unnamed"))
        .await
        .expect("an unnamed command is answered");
    let moved = controls
        .move_command_to_background(&running_command(&session, "task-b"))
        .await
        .expect("the request is answered");

    assert!(!unnamed, "a command Claude Code never named does not move");
    assert!(moved, "the named command moves");
    let requests = session.control_requests_after_start();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["subtype"], "background_tasks");
    assert_eq!(requests[0]["tool_use_id"], "call-b");
}

fn helper(session: &ScriptedSession, run_id: RunId, subagent_id: &str) -> HelperBackgroundParams {
    HelperBackgroundParams {
        session_id: session.session_id,
        run_id,
        child_handle: ChildHandle::new(format!("handle-{subagent_id}")).expect("a handle"),
        subagent_id: SubagentId::new(subagent_id.to_owned()).expect("a helper id"),
    }
}

// A helper's `task_started` in the foreground, by the `Agent` call that started it.
fn foreground_helper_started(subagent_id: &str, tool_use_id: &str) -> serde_json::Value {
    json!({
        "type": "system",
        "subtype": "task_started",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "task_id": subagent_id,
        "task_type": "local_agent",
        "tool_use_id": tool_use_id,
        "is_backgrounded": false,
    })
}

// Killed by moving a helper through any call but the one that started it, or by the bare request,
// which would move a running command too; by asking Claude Code to move a helper whose call was
// answered, which has finished, or one Claude Code moved to the background already; and by asking
// for a helper no thread waits on.
#[tokio::test(start_paused = true)]
async fn a_helper_moves_to_the_background_through_the_call_that_started_it() {
    let session = ScriptedSession::new().await;
    let run_id = session.hold_lead_turn("lead");
    for (subagent_id, tool_use_id) in [
        ("helper-1", "call-1"),
        ("finished", "call-2"),
        ("moved", "call-3"),
    ] {
        session.frame(&foreground_helper_started(subagent_id, tool_use_id));
    }
    session.frame(&json!({
        "type": "user",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "message": {
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": "call-2", "content": "done"}],
        },
    }));
    session.frame(&json!({
        "type": "system",
        "subtype": "task_updated",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "task_id": "moved",
        "patch": {"is_backgrounded": true},
    }));
    settle().await;
    let controls = &session.parts.run_controls;

    let mut answers = Vec::new();
    for subagent_id in ["finished", "moved", "unknown", "helper-1"] {
        let moved = controls
            .move_helper_to_background(&helper(&session, run_id, subagent_id))
            .await
            .expect("the move is answered");
        answers.push((subagent_id, moved));
    }

    assert_eq!(
        answers,
        [
            ("finished", false),
            ("moved", false),
            ("unknown", false),
            ("helper-1", true),
        ]
    );
    let requests = session.control_requests_after_start();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["subtype"], "background_tasks");
    assert_eq!(requests[0]["tool_use_id"], "call-1");
}

// Killed by attributing a helper's block to the lead run, and by writing the `Allow once` for
// it into the lead's turn instead of handing it to the helper; and by writing the lead's
// `Allow once` without the human origin, or marked as the daemon's own words.
#[tokio::test(start_paused = true)]
async fn a_helpers_block_and_its_allow_once_stay_the_helpers() {
    let session = ScriptedSession::new().await;
    session
        .live
        .settings
        .lock()
        .expect("the settings' lock holds")
        .execution_posture = Some(ExecutionPosture::Reviewed {
        credential_policy_ref: CredentialPolicyRef::new("policy".to_owned())
            .expect("a test policy reference fits"),
        writable_roots: Vec::new(),
    });
    let lead = session.hold_lead_turn("lead");
    let helper = session.bind_helper(lead, "helper");
    let tool_input = json!({"command": "rm -rf build"});
    session.request(
        "denied",
        &json!({
            "subtype": "hook_callback",
            "callback_id": "sidekicks-permission-denied",
            "input": {
                "hook_event_name": "PermissionDenied",
                "agent_id": "helper",
                "tool_name": "Bash",
                "tool_use_id": "call-1",
                "tool_input": tool_input,
                "reason": "it deletes the build",
            },
        }),
    );
    settle().await;
    assert_eq!(session.ports.calls(), [PortCall::Denial(helper)]);

    session
        .parts
        .run_controls
        .override_denial(&OverrideDenialParams {
            session_id: session.session_id,
            run_id: helper,
            provider_denial: serde_json::value::to_raw_value(&json!({
                "tool_name": "Bash",
                "tool_input": tool_input,
                "tool_use_id": "call-1",
            }))
            .expect("a denial serializes"),
        })
        .await
        .expect("the override reaches the helper");

    assert_eq!(
        session.channel.user_frames(),
        Vec::<serde_json::Value>::new()
    );
    let answer = session
        .helper_steers
        .lock()
        .expect("the helper steers' lock holds")
        .answer_after_tool(session.session_id, Some("helper"));
    assert!(matches!(
        answer,
        ClaudeHookAnswer::AddContext { context, .. }
            if context.contains("Permission granted for: Bash(rm -rf build)")
    ));

    session
        .parts
        .run_controls
        .override_denial(&OverrideDenialParams {
            session_id: session.session_id,
            run_id: lead,
            provider_denial: serde_json::value::to_raw_value(&json!({
                "tool_name": "Bash",
                "tool_input": tool_input,
                "tool_use_id": "call-2",
            }))
            .expect("a denial serializes"),
        })
        .await
        .expect("the override reaches the lead's turn");

    let frames = session.channel.user_frames();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0]["origin"], json!({"kind": "human"}));
    assert_eq!(frames[0].get("client_composed"), None);
}
