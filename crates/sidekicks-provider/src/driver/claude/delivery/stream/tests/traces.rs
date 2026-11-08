//! What a Claude Code session hands the trace recorder: each helper call at its result, each tool
//! server's background call, the lead's or a helper's, at its task's notification, and a call kept
//! on disk past the memory bound, read back at its result.

use std::time::Duration;

use serde_json::{Value, json};

use crate::driver::claude::session::scripted::held_calls::{
    export_calls, helper_started, init, stand_in,
};
use crate::driver::claude::session::scripted::{
    SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession, settle,
};
use crate::port::tool_traces::ToolTrace;
use crate::run::delivery::LateAppendableRow;
use crate::tool_call_arguments::{TOOL_CALL_ARGUMENT_BOUNDS, tool_call_arguments_folder};

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

// Past the bound on calls kept in memory the oldest helper call's arguments go to the process's
// file, and its trace still carries them word for word, read back at its result; the file goes
// once nothing on it waits. Mutations: no spill after a helper's calls (no file); arguments past
// the bound dropped (h-0 untraced, 256 traces); the file kept once read back (a file remains).
#[tokio::test(start_paused = true)]
async fn a_call_kept_past_the_memory_bound_is_traced_from_disk() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    session.ports.tool_traces.set_recording(true);
    let calls = TOOL_CALL_ARGUMENT_BOUNDS.calls + 1;
    let input = |index: usize| json!({"file_path": format!("/repo/{index}.txt"), "index": index});

    session.frame(&init());
    session.frame(&helper_started("helper", "local_agent", "agent-call"));
    for index in 0..calls {
        let call_id = format!("h-{index}");
        session.frame(&helper_call("helper", &call_id, "Read", &input(index)));
    }
    // The lead's message comes after every helper frame, so its row says the spill is done.
    session.frame(&json!({
        "type": "assistant",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "message": {
            "id": "lead-message",
            "role": "assistant",
            "content": [{"type": "text", "text": "Reading"}],
        },
    }));
    tokio::time::timeout(
        Duration::from_secs(10),
        session.engine.wait_until(|_| {
            session
                .engine
                .deliveries()
                .iter()
                .any(|delivery| {
                    matches!(delivery.row, Some(LateAppendableRow::AgentMessageSent(_)))
                })
                .then_some(())
        }),
    )
    .await
    .expect("the lead's message is delivered");
    let folder = tool_call_arguments_folder(&session.data_folder);
    let files: Vec<_> = std::fs::read_dir(&folder)
        .expect("the spill folder is made")
        .map(|entry| entry.expect("the folder reads").path())
        .collect();
    assert_eq!(
        files.len(),
        1,
        "one file holds the process's spilled arguments"
    );
    assert_eq!(
        std::fs::read_to_string(&files[0]).expect("the file reads"),
        input(0).to_string(),
        "only the oldest call passed the bound"
    );

    for index in 0..calls {
        let call_id = format!("h-{index}");
        session.frame(&helper_result("helper", &call_id, &json!("read")));
    }
    let traces = tokio::time::timeout(
        Duration::from_secs(10),
        session.ports.tool_traces.wait_for(calls),
    )
    .await
    .expect("every call is traced");
    assert_eq!(traces.len(), calls);
    assert_eq!(traces[0].tool_call_id, "h-0");
    assert_eq!(traces[0].arguments.get(), input(0).to_string());
    assert_eq!(
        traces[calls - 1].arguments.get(),
        input(calls - 1).to_string()
    );
    assert_eq!(
        std::fs::read_dir(&folder)
            .expect("the folder reads")
            .count(),
        0,
        "the file goes once nothing on it waits"
    );
}

// A helper's end forgets the arguments of its calls still awaiting results, so none outlives it.
// Killed by an end that leaves the helper's open calls kept (the bytes stay).
#[tokio::test(start_paused = true)]
async fn a_helpers_end_forgets_its_calls_awaiting_results() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    session.frame(&init());
    // A foreground helper, which waits on the call that started it.
    let mut started = helper_started("helper", "local_agent", "agent-call");
    started["is_backgrounded"] = json!(false);
    session.frame(&started);
    let input = json!({"file_path": "/repo/a.txt"});
    session.frame(&helper_call("helper", "h-open", "Read", &input));
    settle().await;
    assert_eq!(
        session.stream.tool_call_arguments.in_memory_bytes(),
        input.to_string().len(),
        "the helper's open call is kept"
    );

    // The lead's answer to the call that started the helper ends it.
    session.frame(&json!({
        "type": "user",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "message": {
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": "agent-call", "content": "Done"}],
        },
    }));
    settle().await;
    assert_eq!(session.stream.tool_call_arguments.in_memory_bytes(), 0);
}
