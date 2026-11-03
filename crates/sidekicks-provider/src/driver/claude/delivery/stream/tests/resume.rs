use std::sync::Arc;

use jiff::{SignedDuration, Timestamp};
use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::event::declared_variants::ToolCallEndCause;

use super::{helper_started, init, result};
use crate::driver::claude::delivery::mcp_tasks::restore::ClaudeKeptCallsSource;
use crate::driver::claude::session::scripted::driver::{ScriptedDriver, resume_params};
use crate::driver::claude::session::scripted::held_calls::{
    Ending, closes, held_call, logged_held_calls, record, registered, write_kept_files,
};
use crate::driver::claude::session::scripted::{
    SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession, binding_id, settle,
};
use crate::driver::test_registry::new_run_id;

// Fails when a resume leaves the log's held calls unrebuilt, ignores a saved ending, or times a
// rebuilt opening from the rebuild rather than its stored time. Mutations: the hook in
// `bring_up_and` removed (no close at all); `into_end` reading `Ended` as still running
// (no close for call-2); the opening timed from `Timestamp::now()` (call-1's duration near zero).
#[tokio::test(start_paused = true)]
async fn a_resume_rebuilds_the_held_calls_from_the_log_and_the_kept_files() {
    let fixture = ScriptedDriver::new();
    let session_id = fixture.closed_session_resumed_on(Arc::default()).await;
    let params = resume_params(session_id);
    let run = (new_run_id(), "binding-a");
    let invoked_at = Timestamp::now() - SignedDuration::from_secs(90);
    fixture
        .services
        .ports
        .held_tool_calls
        .register(logged_held_calls(
            vec![
                held_call(
                    "call-5",
                    "task-5",
                    run,
                    None,
                    Some(ToolCallEndCause::DaemonRestart),
                ),
                held_call("call-3", "task-3", run, None, None),
                held_call("call-2", "task-2", run, None, None),
                held_call("call-1", "task-1", run, Some(invoked_at), None),
            ],
            &fixture.engine,
        ))
        .expect("the read registers once");
    write_kept_files(
        &fixture.home.join(".claude"),
        &params.resume_handle,
        &[
            (
                "mcp-task-task-2.outcome.json",
                json!({
                    "toolUseId": "call-2",
                    "status": "completed",
                    "statusMessage": "Exported",
                    "serverName": "files",
                    "toolName": "export",
                }),
            ),
            ("mcp-task-task-3.meta.json", record("call-3")),
        ],
    );

    fixture
        .driver
        .resume_session(params)
        .await
        .expect("the resume answers");
    fixture.next_start().await;
    settle().await;

    let closes = closes(fixture.engine.deliveries());
    let shapes: Vec<_> = closes
        .iter()
        .map(|close| {
            (
                close.tool_call_id.as_str(),
                close.kind,
                close.binding_id.clone(),
                close.run_id,
                &close.ending,
                close.content.as_deref(),
            )
        })
        .collect();
    let binding = Some(binding_id("binding-a"));
    assert_eq!(
        shapes,
        [
            (
                "call-1",
                "afterRunRow",
                binding.clone(),
                run.0,
                &Ending::Failed(Some(ToolCallEndCause::ProcessExit)),
                None,
            ),
            (
                "call-2",
                "afterRunRow",
                binding,
                run.0,
                &Ending::Completed,
                Some("Exported")
            ),
        ]
    );
    let call_1_duration = closes[0].duration_ms.expect("the close is timed");
    assert!(
        call_1_duration >= 90_000,
        "call-1 took {call_1_duration} ms"
    );
}

// Fails when a call the resume held again from its record, or one the daemon had settled, does
// not close on its restored task's ending. Mutations: `keep_settled` skipped, or daemon-settled
// calls left out (no row for call-5); `hold_restored` skipped (no row for call-3).
#[tokio::test(start_paused = true)]
async fn a_restored_call_and_a_daemon_settled_one_land_their_endings() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    let config_folder = tempfile::tempdir().expect("a scratch config folder");
    let conversation = "resumed-conversation";
    write_kept_files(
        config_folder.path(),
        conversation,
        &[("mcp-task-task-3.meta.json", record("call-3"))],
    );
    let run = (new_run_id(), "binding-a");
    let held_calls = registered(
        vec![
            held_call(
                "call-5",
                "task-5",
                run,
                None,
                Some(ToolCallEndCause::DaemonRestart),
            ),
            held_call("call-3", "task-3", run, None, None),
        ],
        &session.engine,
    );
    session
        .parts
        .establishment
        .task_services
        .delivery
        .rebuild_held_calls(
            &session.stream,
            &held_calls,
            &ClaudeKeptCallsSource::new(
                Some(config_folder.path().to_owned()),
                conversation.to_owned(),
            ),
        )
        .await
        .expect("the log reads");

    session.frame(&init());
    for (task_id, call_id) in [("task-3", "call-3"), ("task-5", "call-5")] {
        session.frame(&helper_started(task_id, "mcp_task", call_id));
        session.frame(&json!({
            "type": "system",
            "subtype": "task_notification",
            "session_id": SCRIPTED_PROVIDER_SESSION_ID,
            "task_id": task_id,
            "tool_use_id": call_id,
            "status": "completed",
            "summary": "Exported",
        }));
    }
    settle().await;

    let landed: Vec<_> = closes(session.engine.deliveries())
        .into_iter()
        .map(|close| (close.tool_call_id, close.kind, close.ending))
        .collect();
    assert_eq!(
        landed,
        [
            ("call-3".to_owned(), "afterRunRow", Ending::Completed),
            ("call-5".to_owned(), "afterRunRow", Ending::Completed),
        ]
    );
}

// A background list naming the tasks `task_ids`.
fn background_list(task_ids: &[&str]) -> Value {
    let tasks: Vec<Value> = task_ids
        .iter()
        .map(|task_id| json!({"task_id": task_id, "task_type": "mcp_task"}))
        .collect();
    json!({
        "type": "system",
        "subtype": "background_tasks_changed",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "tasks": tasks,
    })
}

// Fails when a call held again from its record and never restored outlives the resumed process's
// first background list that leaves it out or, where that list names it, the first finished reply,
// when a later list that leaves it out before its restore closes it, or when either stop ends a
// call opened in the resumed turn. Mutations: the level arm's `end_unrestored` dropped (the list
// settles call-4 `stopped`); `end_turn`'s dropped (no close at the reply); `take_unlisted` ending
// the calls the list names (a close before the reply); `settle_unlisted` settling a call still
// awaiting its restore (the second list closes call-4 `stopped`); either stop ending every open
// call (a row for call-9).
#[rstest]
#[case::left_out_of_the_first_list(Vec::new(), background_list(&[]))]
#[case::named_by_the_first_list_then_the_first_reply(
    vec![background_list(&["task-4"])],
    result(&json!({})),
)]
#[case::named_by_the_first_list_left_out_of_the_second_then_the_first_reply(
    vec![background_list(&["task-4"]), background_list(&[])],
    result(&json!({})),
)]
#[tokio::test(start_paused = true)]
async fn a_restored_call_waits_until_the_first_list_or_reply(
    #[case] lists: Vec<Value>,
    #[case] stop: Value,
) {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    let config_folder = tempfile::tempdir().expect("a scratch config folder");
    let conversation = "resumed-conversation";
    write_kept_files(
        config_folder.path(),
        conversation,
        &[("mcp-task-task-4.meta.json", record("call-4"))],
    );
    let run = (new_run_id(), "binding-a");
    session
        .parts
        .establishment
        .task_services
        .delivery
        .rebuild_held_calls(
            &session.stream,
            &registered(
                vec![held_call("call-4", "task-4", run, None, None)],
                &session.engine,
            ),
            &ClaudeKeptCallsSource::new(
                Some(config_folder.path().to_owned()),
                conversation.to_owned(),
            ),
        )
        .await
        .expect("the log reads");
    session.frame(&init());
    session.frame(&json!({
        "type": "assistant",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "message": {
            "id": "message-1",
            "role": "assistant",
            "content": [
                {"type": "tool_use", "id": "call-9", "name": "mcp__files__read", "input": {}},
            ],
        },
    }));
    for list in lists {
        session.frame(&list);
        settle().await;
        assert_eq!(closes(session.engine.deliveries()), []);
    }

    session.frame(&stop);
    settle().await;

    let ended: Vec<_> = closes(session.engine.deliveries())
        .into_iter()
        .map(|close| {
            (
                close.tool_call_id,
                close.kind,
                close.binding_id,
                close.ending,
            )
        })
        .collect();
    assert_eq!(
        ended,
        [(
            "call-4".to_owned(),
            "afterRunRow",
            Some(binding_id("binding-a")),
            Ending::Failed(Some(ToolCallEndCause::ProcessExit)),
        )]
    );
}
