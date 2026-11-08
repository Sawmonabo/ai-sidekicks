use std::io::{BufRead as _, BufReader};
use std::time::Duration;

use serde_json::{Value, json};
use sidekicks_contracts::command::CommandId;
use sidekicks_contracts::provider::driver::capabilities::{CredentialPolicyRef, ExecutionPosture};
use sidekicks_platforms::RUNS_COMMAND_WRAPPER;

use crate::command::channel::test_support::{
    end_party, new_party_keys, party_command, ready_parties, sent_requests, write_party_record,
};
use crate::command::channel::{DaemonRequest, PartyRecord};
use crate::command::running_set::unbound_running_command_sets;
use crate::driver::claude::hooks::pause::ClaudeHookAnswer;
use crate::driver::claude::session::scripted::channel::{ScriptedAnswer, ScriptedWrite};
use crate::driver::claude::session::scripted::daemon_services::PortCall;
use crate::driver::claude::session::scripted::{
    SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession, binding_id, settle,
};
use crate::driver::run_control::OverrideDenialParams;
use crate::port::running_command_publisher::{
    CommandStopCause, RunningCommandParams, StopCommandParams,
};

fn running_command(session: &ScriptedSession, command_id: &str) -> RunningCommandParams {
    RunningCommandParams {
        session_id: session.session_id,
        binding_id: binding_id("lead"),
        command_id: CommandId::new(command_id.to_owned()).expect("a command id"),
    }
}

fn stop_for(
    session: &ScriptedSession,
    command_id: &str,
    cause: CommandStopCause,
) -> StopCommandParams {
    StopCommandParams {
        command: running_command(session, command_id),
        cause,
    }
}

// Starts a Bash command `sleep 100` as the task `task-1` of the lead's held turn.
fn start_sleep_task(session: &ScriptedSession) {
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
}

// Waits up to five seconds for `holds`.
async fn wait_until(holds: impl Fn() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !holds() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("it holds in time");
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
    start_sleep_task(&session);
    settle().await;
    let controls = &session.parts.run_controls;
    session.channel.answer("stop_task", ScriptedAnswer::Refused);

    let refused = controls
        .stop_command(&stop_for(&session, "task-1", CommandStopCause::Person))
        .await;
    let stopped = controls
        .stop_command(&stop_for(&session, "task-1", CommandStopCause::Person))
        .await;
    session
        .channel
        .answer("stop_task", ScriptedAnswer::WriteCut);
    let cut = controls
        .stop_command(&stop_for(&session, "task-1", CommandStopCause::Person))
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

// An undo's stop reaches the command's wrapper only once Claude Code took its `stop_task`, and
// tells the run nothing, while the person's stop still tells it. Killed by telling the run on every
// cause, and by sending the wrapper's `Stop` before `stop_task`, which a refused `stop_task` then
// leaves sent.
#[tokio::test]
async fn an_undo_stop_tells_the_run_nothing() {
    if !RUNS_COMMAND_WRAPPER {
        return;
    }
    let sets = unbound_running_command_sets();
    let session = ScriptedSession::with_running_commands(std::sync::Arc::clone(&sets)).await;
    session.hold_lead_turn("lead");
    start_sleep_task(&session);
    settle().await;
    let channel = session
        .live
        .spawn_bound_legs
        .command_channel
        .clone()
        .expect("the session's process has a channel");
    // The test's own process stands in for Claude Code's, so the wrapper it starts is admitted.
    channel.follow(std::process::id());
    let keys = new_party_keys();
    let mut wrapper = party_command(&keys, None)
        .spawn()
        .expect("the wrapper starts");
    let mut lines = BufReader::new(wrapper.stdout.take().expect("its output")).lines();
    let party = ready_parties(&mut lines, 1)[0];
    write_party_record(
        channel.command_channel(),
        &keys,
        party,
        1,
        &PartyRecord::Starting {
            command: "sleep 100".to_owned(),
            stdout_path: None,
            process: None,
        },
    );
    let command_id = CommandId::new("task-1".to_owned()).expect("a command id");
    wait_until(|| sets.paired_wrapper(session.session_id, &command_id) == Some(party)).await;
    let requests = || sent_requests(channel.command_channel(), &keys, party);
    wait_until(|| requests().len() == 2).await;
    let controls = &session.parts.run_controls;

    session.channel.answer("stop_task", ScriptedAnswer::Refused);
    let refused = controls
        .stop_command(&stop_for(&session, "task-1", CommandStopCause::Undo))
        .await;
    assert!(refused.is_err(), "a refused stop fails");
    assert!(!requests().contains(&DaemonRequest::Stop {}));
    let stopped = controls
        .stop_command(&stop_for(&session, "task-1", CommandStopCause::Undo))
        .await
        .expect("the undo's stop is acknowledged");

    assert_eq!(requests().last(), Some(&DaemonRequest::Stop {}));
    assert_eq!(stopped.process_ids(), [party]);
    assert_eq!(session.channel.user_frames(), Vec::<Value>::new());
    controls
        .stop_command(&stop_for(&session, "task-1", CommandStopCause::Person))
        .await
        .expect("the person's stop is acknowledged");
    let told = session.channel.user_frames();
    assert_eq!(told.len(), 1);
    assert!(
        told[0]
            .to_string()
            .contains("The user stopped `sleep 100`.")
    );
    end_party(wrapper);
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
