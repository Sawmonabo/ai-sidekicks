use std::time::Duration;

use serde_json::json;
use sidekicks_contracts::event::declared_variants::ToolCallEndCause;
use sidekicks_platforms::PathRules;

use crate::driver::claude::session::scripted::daemon_services::PortCall;
use crate::driver::claude::session::scripted::held_calls::{
    Ending, closes, export_calls, helper_started, init, record, stand_in, write_kept_files,
};
use crate::driver::claude::session::scripted::{ScriptedSession, binding_id, settle};
use crate::driver::claude::spawn::environment::claude_config_folder;
use crate::run::delivery::LateAppendableRow;

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
    write_kept_files(
        &config_folder,
        &session.live.provider_session_id,
        &[
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
            ("mcp-task-task-2.meta.json", record("call-2")),
        ],
    );
    let running = "Running in the background";
    let ending = "Export started; it does not survive exiting this session";

    session.frame(&init());
    session.frame(&export_calls(&["call-1", "call-2", "call-3"]));
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
            (closed.iter().any(|close| close.tool_call_id == "call-1")
                && closed.iter().any(|close| close.tool_call_id == "call-3"))
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
    let mut closed: Vec<_> = closes(deliveries)
        .into_iter()
        .map(|close| (close.tool_call_id, close.kind, close.ending, close.content))
        .collect();
    closed.sort_by(|left, right| left.0.cmp(&right.0));
    assert_eq!(
        closed,
        [
            (
                "call-1".to_owned(),
                "afterRunRow",
                Ending::Failed(Some(ToolCallEndCause::Stopped)),
                Some("server cancelled the export".to_owned()),
            ),
            (
                "call-3".to_owned(),
                "afterRunRow",
                Ending::Failed(Some(ToolCallEndCause::ProcessExit)),
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
