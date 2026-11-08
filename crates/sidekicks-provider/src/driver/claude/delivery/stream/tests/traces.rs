//! What a Claude Code session hands the trace recorder: each helper call at its result, and each
//! tool server's background call, the lead's or a helper's, at its task's notification.

use serde_json::{Value, json};

use crate::driver::claude::session::scripted::held_calls::{
    export_calls, helper_started, init, stand_in,
};
use crate::driver::claude::session::scripted::{
    SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession, settle,
};
use crate::port::tool_traces::ToolTrace;

// A helper's message calling `tool_name` under `call_id` with `input`.
fn helper_call(helper_id: &str, call_id: &str, tool_name: &str, input: &Value) -> Value {
    json!({
        "type": "assistant",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "agent_id": helper_id,
        "message": {
            "id": format!("message-{call_id}"),
            "role": "assistant",
            "content": [{"type": "tool_use", "id": call_id, "name": tool_name, "input": input}],
        },
    })
}

// A helper's frame answering `call_id` with `content`.
fn helper_result(helper_id: &str, call_id: &str, content: &Value) -> Value {
    json!({
        "type": "user",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "agent_id": helper_id,
        "message": {
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": call_id, "content": content}],
        },
    })
}

// The notification ending the tool server's task `task_id`, which ran the call `call_id`.
fn task_completed(task_id: &str, call_id: &str) -> Value {
    json!({
        "type": "system",
        "subtype": "task_notification",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "task_id": task_id,
        "tool_use_id": call_id,
        "status": "completed",
        "summary": "Exported",
        "resource_links": [{"uri": "file:///export/report.csv", "name": "report.csv"}],
    })
}

// Each trace as its call, tool, arguments and result, all as JSON values.
fn read(traces: &[ToolTrace]) -> Vec<(String, String, Value, Value)> {
    traces
        .iter()
        .map(|trace| {
            let json = |raw: &serde_json::value::RawValue| {
                serde_json::from_str::<Value>(raw.get()).expect("a trace body is JSON")
            };
            (
                trace.tool_call_id.clone(),
                trace.tool_name.clone(),
                json(&trace.arguments),
                json(&trace.result),
            )
        })
        .collect()
}

// A helper's call is traced once, at its result, with its input and the result's content; a
// helper frame held until its helper registered is read all the same; a tool server's background
// call, the lead's or a helper's, is traced once, at its task's notification, with the whole
// notification, never with the stand-in result. Mutations: the helper path not tracing
// (`read_traces` skipped); the released frame metered only (no `h-early` trace); the helper's
// held call left open (the stand-in closes it, traced with "Running"); the notification not
// releasing the helper's call (no `h-export` trace); the lead's notification left untraced.
#[tokio::test(start_paused = true)]
async fn helper_calls_and_background_calls_are_traced_at_their_results() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    session.ports.tool_traces.set_recording(true);
    let input = json!({"command": "ls", "description": "List files"});
    let early_input = json!({"file_path": "/repo/README.md"});
    let export_input = json!({"format": "csv"});

    session.frame(&init());
    // Written before its helper's start, so it waits for the registration.
    session.frame(&helper_call("late", "h-early", "Read", &early_input));
    session.frame(&helper_started("late", "local_agent", "agent-call-late"));
    session.frame(&helper_started("helper", "local_agent", "agent-call"));
    session.frame(&helper_call("helper", "h-call", "Bash", &input));
    session.frame(&helper_result("helper", "h-call", &json!("README.md")));
    session.frame(&helper_result(
        "late",
        "h-early",
        &json!([{"type": "text", "text": "# Repo"}]),
    ));
    session.frame(&helper_call(
        "helper",
        "h-export",
        "mcp__files__export",
        &export_input,
    ));
    session.frame(&helper_started("h-task", "mcp_task", "h-export"));
    session.frame(&helper_result(
        "helper",
        "h-export",
        &json!("Running in the background"),
    ));
    session.frame(&export_calls(&["call-1"]));
    session.frame(&helper_started("task-1", "mcp_task", "call-1"));
    session.frame(&stand_in("call-1", "Running in the background"));
    let helper_ending = task_completed("h-task", "h-export");
    let lead_ending = task_completed("task-1", "call-1");
    session.frame(&helper_ending);
    session.frame(&lead_ending);
    settle().await;

    assert_eq!(
        read(&session.ports.tool_traces.traces()),
        [
            (
                "h-call".to_owned(),
                "Bash".to_owned(),
                input,
                json!("README.md")
            ),
            (
                "h-early".to_owned(),
                "Read".to_owned(),
                early_input,
                json!([{"type": "text", "text": "# Repo"}]),
            ),
            (
                "h-export".to_owned(),
                "mcp__files__export".to_owned(),
                export_input,
                helper_ending,
            ),
            (
                "call-1".to_owned(),
                "mcp__files__export".to_owned(),
                json!({}),
                lead_ending,
            ),
        ]
    );
}
