use std::time::Duration;

use serde_json::{Value, json};
use sidekicks_contracts::event::declared_variants::ToolCallEndCause;
use sidekicks_platforms::PathRules;

use super::{helper_started, init};
use crate::driver::claude::session::scripted::daemon_services::PortCall;
use crate::driver::claude::session::scripted::{
    SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession, binding_id, settle,
};
use crate::driver::claude::spawn::environment::claude_config_folder;
use crate::port::run_host::test_host::RecordedDelivery;
use crate::run::delivery::LateAppendableRow;

// The stand-in result Claude Code answers the background call `call_id` with, in `words`.
fn stand_in(call_id: &str, words: &str) -> Value {
    json!({
        "type": "user",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "message": {
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": call_id, "content": words}],
        },
    })
}

// Each close of a tool call delivered so far, by the call's id: its kind, end cause and body.
fn closes(
    deliveries: Vec<RecordedDelivery>,
) -> Vec<(
    String,
    &'static str,
    Option<ToolCallEndCause>,
    Option<String>,
)> {
    let mut closes: Vec<_> = deliveries
        .into_iter()
        .filter_map(|delivery| {
            let row = delivery.row?;
            let (tool_call_id, end_cause) =
                if let LateAppendableRow::AgentToolCallCompleted(activity) = row {
                    (activity.tool_call_id?, None)
                } else if let LateAppendableRow::AgentToolCallFailed(failed) = row {
                    (failed.tool_call_id?, failed.end_cause)
                } else {
                    return None;
                };
            Some((
                tool_call_id.as_str().to_owned(),
                delivery.kind,
                end_cause,
                delivery.content,
            ))
        })
        .collect();
    closes.sort_by(|left, right| left.0.cmp(&right.0));
    closes
}

// Fails when a held call's stand-in is not its `backgrounded` row, when its survival is not read
// from what Claude Code kept before its words, or when a process that ends unasked leaves its held
// calls unsettled or settles them other than by what Claude Code kept. Mutations: the saved ending
// ignored (call-1 left open, no `stopped` close); survival inverted or read off the words alone
// (call-1 and call-2 read `false`); the settle skipped in `end()`, or `end_session` answering no
// held calls (no close for call-3, the wait times out).
#[tokio::test(start_paused = true)]
async fn an_unmarked_exit_settles_each_held_call_by_what_claude_code_kept() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    let config_folder = claude_config_folder(
        &session.live.signed_in_spawn_environment(),
        PathRules::NATIVE,
    )
    .expect("the scripted session's home is known");
    let provider_session_id = &session.live.provider_session_id;
    let project = config_folder.join("projects").join("p");
    let kept = project.join(provider_session_id).join("mcp-tasks");
    std::fs::create_dir_all(&kept).expect("the kept folder is made");
    std::fs::write(project.join(format!("{provider_session_id}.jsonl")), "")
        .expect("the conversation file is written");
    for (name, contents) in [
        (
            "mcp-task-task-1.outcome.json",
            json!({
                "toolUseId": "call-1",
                "status": "cancelled",
                "statusMessage": "server cancelled the export",
                "serverName": "files",
                "toolName": "export",
            }),
        ),
        (
            "mcp-task-task-2.meta.json",
            json!({"toolUseId": "call-2", "serverName": "files", "toolName": "export"}),
        ),
    ] {
        std::fs::write(kept.join(name), contents.to_string()).expect("a kept file is written");
    }
    let running = "Running in the background";
    let ending = "Export started; it does not survive exiting this session";

    session.frame(&init());
    session.frame(&json!({
        "type": "assistant",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "message": {
            "id": "message-1",
            "role": "assistant",
            "content": [
                {"type": "tool_use", "id": "call-1", "name": "mcp__files__export", "input": {}},
                {"type": "tool_use", "id": "call-2", "name": "mcp__files__export", "input": {}},
                {"type": "tool_use", "id": "call-3", "name": "mcp__files__export", "input": {}},
            ],
        },
    }));
    for (task_id, call_id) in [
        ("task-1", "call-1"),
        ("task-2", "call-2"),
        ("task-3", "call-3"),
    ] {
        session.frame(&helper_started(task_id, "mcp_task", call_id));
    }
    session.frame(&stand_in("call-1", running));
    session.frame(&stand_in("call-2", running));
    session.frame(&stand_in("call-3", ending));
    settle().await;
    session.exit();
    tokio::time::timeout(
        Duration::from_secs(10),
        session.engine.wait_until(|_| {
            let closed = closes(session.engine.deliveries());
            (closed.iter().any(|close| close.0 == "call-1")
                && closed.iter().any(|close| close.0 == "call-3"))
            .then_some(())
        }),
    )
    .await
    .expect("the exit settles call-1 and call-3");
    settle().await;

    let deliveries = session.engine.deliveries();
    let mut backgrounded: Vec<_> = deliveries
        .iter()
        .filter_map(|delivery| {
            let Some(LateAppendableRow::AgentToolCallBackgrounded(payload)) = &delivery.row else {
                return None;
            };
            Some((
                payload.tool_call_id.as_str().to_owned(),
                payload.survives_restart,
                delivery.kind,
                delivery.binding_id.clone(),
                delivery.content.clone(),
            ))
        })
        .collect();
    backgrounded.sort_by(|left, right| left.0.cmp(&right.0));
    let lead = Some(binding_id("lead"));
    assert_eq!(
        backgrounded,
        [
            (
                "call-1".to_owned(),
                true,
                "afterRunRow",
                lead.clone(),
                Some(running.to_owned())
            ),
            (
                "call-2".to_owned(),
                true,
                "afterRunRow",
                lead.clone(),
                Some(running.to_owned())
            ),
            (
                "call-3".to_owned(),
                false,
                "afterRunRow",
                lead,
                Some(ending.to_owned())
            ),
        ]
    );
    assert_eq!(
        closes(deliveries),
        [
            (
                "call-1".to_owned(),
                "afterRunRow",
                Some(ToolCallEndCause::Stopped),
                Some("server cancelled the export".to_owned()),
            ),
            (
                "call-3".to_owned(),
                "afterRunRow",
                Some(ToolCallEndCause::ProcessExit),
                None,
            ),
        ]
    );
    let mut statuses: Vec<_> = session
        .ports
        .calls()
        .into_iter()
        .filter_map(|call| {
            let PortCall::ToolCallStatus {
                tool_call_id,
                status,
            } = call
            else {
                return None;
            };
            Some((tool_call_id, status))
        })
        .collect();
    statuses.sort();
    assert_eq!(
        statuses,
        [("call-1".to_owned(), None), ("call-3".to_owned(), None)]
    );
}
