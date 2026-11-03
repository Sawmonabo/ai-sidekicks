use serde_json::json;

use super::result;
use crate::driver::claude::session::scripted::daemon_services::PortCall;
use crate::driver::claude::session::scripted::held_calls::{
    export_calls, helper_started, init, stand_in,
};
use crate::driver::claude::session::scripted::{
    SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession, binding_id, settle,
};
use crate::run::delivery::LateAppendableRow;

// The words of Claude Code's stand-in result for a call it moved to the background.
const RUNNING: &str = "Running in the background";

// Fails when a held call's move to the background, read once its opening run ended and a newer
// binding holds the turn, or its close lands anywhere but after the run that opened the call, on
// that run's binding, as a row no cursor stamps, or when its progress is not its status line or
// the line outlives the close. Mutations: the background row as `ClaudeRow::Late` (kind
// `sessionRow`, which needs the dropped cursor of binding-a) or on the turn's binding
// (binding-b); the close reading the opening from the open calls, which B's turn end cleared (no
// close); `observe_start` holding the call on `task_run`'s run (run B, binding-b) or the close on
// it (binding-c); the close on the session's newest binding (binding-c); the close as
// `ClaudeRow::Late` (kind `sessionRow`); `SystemTaskProgress` left out of `is_task` or no
// `progress_call` arm (no status); the clear skipped (no `None`).
#[tokio::test(start_paused = true)]
async fn a_held_call_ending_after_its_turn_lands_after_its_run_on_its_own_binding() {
    let session = ScriptedSession::new().await;
    let run_a = session.hold_lead_turn("binding-a");

    session.frame(&init());
    session.frame(&export_calls(&["call-1"]));
    // Run B's message, written mid-turn, holds the turn as the call's task starts and parks it.
    session.start.routes.unbind_run(run_a);
    session.hold_lead_turn("binding-b");
    session.frame(&helper_started("task-1", "mcp_task", "call-1"));
    session.frame(&stand_in("call-1", RUNNING));
    session.frame(&json!({
        "type": "system",
        "subtype": "task_progress",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "task_id": "task-1",
        "summary": "Exporting 3 of 5",
    }));
    session.frame(&result(&json!({})));
    // The turn ended; the next run holds it on a newer binding as the call ends.
    session.hold_lead_turn("binding-c");
    session.frame(&json!({
        "type": "system",
        "subtype": "task_notification",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "task_id": "task-1",
        "tool_use_id": "call-1",
        "status": "completed",
        "summary": "Exported",
        "resource_links": [{"uri": "file:///export/report.csv", "name": "report.csv"}],
    }));
    settle().await;

    let backgrounded: Vec<_> = session
        .engine
        .deliveries()
        .into_iter()
        .filter_map(|delivery| {
            let Some(LateAppendableRow::AgentToolCallBackgrounded(payload)) = delivery.row else {
                return None;
            };
            Some((delivery.kind, delivery.binding_id, payload.run_id))
        })
        .collect();
    assert_eq!(
        backgrounded,
        [("afterRunRow", Some(binding_id("binding-a")), run_a)]
    );
    let closes: Vec<_> = session
        .engine
        .deliveries()
        .into_iter()
        .filter(|delivery| {
            matches!(
                delivery.row,
                Some(
                    LateAppendableRow::AgentToolCallCompleted(_)
                        | LateAppendableRow::AgentToolCallFailed(_)
                )
            )
        })
        .collect();
    assert_eq!(closes.len(), 1);
    let close = &closes[0];
    assert_eq!(close.kind, "afterRunRow");
    assert_eq!(close.binding_id, Some(binding_id("binding-a")));
    assert!(matches!(
        &close.row,
        Some(LateAppendableRow::AgentToolCallCompleted(activity)) if activity.run_id == run_a
    ));
    assert_eq!(
        close.content.as_deref(),
        Some("Exported\n- report.csv: file:///export/report.csv")
    );
    let statuses: Vec<_> = session
        .ports
        .calls()
        .into_iter()
        .filter(|call| matches!(call, PortCall::ToolCallStatus { .. }))
        .collect();
    assert_eq!(
        statuses,
        [
            PortCall::ToolCallStatus {
                tool_call_id: "call-1".to_owned(),
                status: Some("Exporting 3 of 5".to_owned()),
            },
            PortCall::ToolCallStatus {
                tool_call_id: "call-1".to_owned(),
                status: None,
            },
        ]
    );
}

// Fails when a tool server's background call closes on the stand-in result Claude Code sends at
// once rather than on its task's notification, or when the call, or another task running no
// command that the background set lists, does not hold the session awake while it runs, or a held
// call's own listed task counts twice. Mutations: `user` passing no held calls; `take_task_frame`
// not releasing the held call; `background_work` leaving out the held calls or the listed tasks,
// leaving out every listed tool server's task (reads 2), or counting the held call's own (reads 4).
#[tokio::test(start_paused = true)]
async fn a_tool_servers_background_call_closes_on_its_task_notification() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    let closed_calls = |session: &ScriptedSession| {
        session
            .engine
            .deliveries()
            .into_iter()
            .filter(|delivery| {
                matches!(
                    delivery.row,
                    Some(
                        LateAppendableRow::AgentToolCallCompleted(_)
                            | LateAppendableRow::AgentToolCallFailed(_)
                    )
                )
            })
            .count()
    };

    session.frame(&init());
    session.frame(&export_calls(&["call-1"]));
    session.frame(&helper_started("task-1", "mcp_task", "call-1"));
    session.frame(&stand_in("call-1", RUNNING));
    session.frame(&json!({
        "type": "system",
        "subtype": "background_tasks_changed",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "tasks": [
            {"task_id": "task-1", "task_type": "mcp_task"},
            {"task_id": "task-2", "task_type": "mcp_task"},
            {"task_id": "workflow-1", "task_type": "local_workflow"},
        ],
    }));
    settle().await;
    assert_eq!(closed_calls(&session), 0);
    assert_eq!(session.stream.background_work(), 3);

    session.frame(&json!({
        "type": "system",
        "subtype": "task_notification",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "task_id": "task-1",
        "tool_use_id": "call-1",
        "status": "completed",
        "summary": "Exported",
    }));
    session.frame(&json!({
        "type": "system",
        "subtype": "background_tasks_changed",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "tasks": [],
    }));
    settle().await;
    assert_eq!(closed_calls(&session), 1);
    assert_eq!(session.stream.background_work(), 0);
}
