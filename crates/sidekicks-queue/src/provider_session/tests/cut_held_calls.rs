//! An undo's settle of the cut turns' open held calls: only the calls opened after the point are
//! named to the driver, and the settle fails when one it named is still open in the log.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use rstest::rstest;
use rusqlite::Connection;
use serde_json::{Value, json};
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::driver::session_control::HeldCallsSettle;
use sidekicks_session::run::held_tool_calls::read_held_tool_calls;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::writer::test_file::insert_test_event;

use super::Opening;
use crate::provider_session::errors::ProviderSessionError;

// The instant every test row is stored at.
const STORED_AT: &str = "2026-10-14T09:00:00.000Z";

// Writes a row of `event_type` for `tool_call_id` of `run_id` in `session_id`, its payload
// `members` beside the members every tool row carries; answers its sequence.
fn write_tool_row(
    writer: &Connection,
    (session_id, run_id): (SessionId, RunId),
    event_type: &str,
    tool_call_id: &str,
    mut members: Value,
) -> i64 {
    members["sessionId"] = json!(session_id);
    members["runId"] = json!(run_id);
    members["toolName"] = json!("mcp__files__export");
    members["toolCallId"] = json!(tool_call_id);
    let (sequence, _) = insert_test_event(
        writer,
        session_id,
        json!({ "type": event_type, "payload": members }),
        None,
        STORED_AT,
    );
    sequence
}

// The background row of `tool_call_id`.
fn write_backgrounded(writer: &Connection, run: (SessionId, RunId), tool_call_id: &str) {
    write_tool_row(
        writer,
        run,
        "agent.toolCall.backgrounded",
        tool_call_id,
        json!({ "taskId": format!("task-of-{tool_call_id}"), "survivesRestart": true }),
    );
}

// The opening of `tool_call_id`, answering its sequence.
fn write_invoked(writer: &Connection, run: (SessionId, RunId), tool_call_id: &str) -> i64 {
    write_tool_row(
        writer,
        run,
        "agent.toolCall.invoked",
        tool_call_id,
        json!({}),
    )
}

// A call id.
fn tool_call_id(id: &str) -> ToolCallId {
    ToolCallId::new(id.to_owned()).expect("a call id")
}

// The settle names to the driver only the call opened after the point: `call-before`, opened
// before it and moved to the background after it, stays open in the log. When the driver closes
// what it was named the settle answers; when it leaves it open the settle fails naming it.
// Mutations: every held call settled (the driver is named `call-before` too); the filter on the
// background row's sequence alone (`call-before`, backgrounded after the point, named); the
// re-read dropped (the open case answers).
#[rstest]
#[case::closed_by_the_driver(true)]
#[case::left_open(false)]
#[tokio::test]
async fn only_the_cut_turns_held_calls_are_named(#[case] is_closed_by_the_driver: bool) {
    let named: Arc<Mutex<Vec<Vec<ToolCallId>>>> = Arc::default();
    let database_path: Arc<Mutex<Option<PathBuf>>> = Arc::default();
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {}), {
        let (named, database_path) = (Arc::clone(&named), Arc::clone(&database_path));
        move |driver, _| {
            driver
                .expect_settle_held_tool_calls()
                .times(1)
                .returning(move |params| {
                    // Any other kind names nothing, which the assertion on the names catches.
                    if let HeldCallsSettle::Undo { calls } = &params.settle {
                        lock(&named)
                            .push(calls.iter().map(|call| call.tool_call_id.clone()).collect());
                        if is_closed_by_the_driver {
                            let path = lock(&database_path).clone().expect("the path is set");
                            let writer = Connection::open(path).expect("the driver opens the log");
                            for call in calls {
                                write_tool_row(
                                    &writer,
                                    (params.session_id, call.run_id),
                                    "agent.toolCall.failed",
                                    call.tool_call_id.as_str(),
                                    json!({ "endCause": "stopped" }),
                                );
                            }
                        }
                    }
                    async { Ok(()) }.boxed()
                });
        }
    })
    .await;
    *lock(&database_path) = Some(opening.database.path());
    opening
        .sessions
        .open(opening.session_id, opening.run_id)
        .await
        .expect("the conversation resumes");
    let writer = opening.database.reader();
    let run = (opening.session_id, opening.earlier_run_id);
    write_invoked(&writer, run, "call-before");
    let point = write_invoked(&writer, run, "call-at-the-point");
    write_backgrounded(&writer, run, "call-before");
    write_invoked(&writer, run, "call-after");
    write_backgrounded(&writer, run, "call-after");

    let settled = opening
        .sessions
        .settle_cut_held_tool_calls(opening.session_id, point)
        .await;

    assert_eq!(*lock(&named), [vec![tool_call_id("call-after")]]);
    if is_closed_by_the_driver {
        settled.expect("the settle answers once each named call is closed");
    } else {
        assert!(
            matches!(
                &settled,
                Err(ProviderSessionError::HeldCallsOpen { tool_call_ids, .. })
                    if *tool_call_ids == [tool_call_id("call-after")]
            ),
            "{settled:?}"
        );
    }
    let still_open: Vec<_> = read_held_tool_calls(&writer, &opening.session_id, None)
        .expect("the log's held calls read")
        .into_iter()
        .filter(|call| call.end_cause.is_none())
        .map(|call| call.tool_call_id)
        .collect();
    let mut expected_open = vec![tool_call_id("call-before")];
    if !is_closed_by_the_driver {
        expected_open.insert(0, tool_call_id("call-after"));
    }
    assert_eq!(still_open, expected_open);
}
