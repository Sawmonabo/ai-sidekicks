use std::sync::Arc;

use rstest::rstest;
use serde_json::{Map, Value, json};

use crate::driver::codex::session::test_fixture::{TEST_THREAD, TestCodexSession};

// The payload of every session-wide event the session's frames appended, in order.
fn session_event_payloads(session: &TestCodexSession) -> Vec<Value> {
    session
        .engine
        .deliveries()
        .into_iter()
        .filter(|delivery| delivery.kind == "sessionEvent")
        .filter_map(|delivery| delivery.payload)
        .collect()
}

// The goal Codex reports on `thread/goal/updated`, at `status`.
fn reported_goal(status: &str) -> Value {
    json!({
        "threadId": TEST_THREAD,
        "objective": "Ship the release notes",
        "status": status,
        "tokensUsed": 120,
        "timeUsedSeconds": 4,
        "createdAt": 1_700_000_000,
        "updatedAt": 1_700_000_004,
    })
}

// Codex's goal rows: an update draws the lead's goal at the status Codex names, one to one and with
// no reason; a clear draws the clear; a status none of the protocol's words draws nothing. Kills:
// a status mapped to the wrong word, a clear read as an update, an unknown word read as active.
#[rstest]
#[case::active("thread/goal/updated", Some("active"), Some("active"))]
#[case::paused("thread/goal/updated", Some("paused"), Some("paused"))]
#[case::blocked("thread/goal/updated", Some("blocked"), Some("blocked"))]
#[case::usage_limited("thread/goal/updated", Some("usageLimited"), Some("usageLimited"))]
#[case::budget_limited("thread/goal/updated", Some("budgetLimited"), Some("budgetLimited"))]
#[case::complete("thread/goal/updated", Some("complete"), Some("complete"))]
#[case::unknown_status("thread/goal/updated", Some("abandoned"), None)]
#[case::cleared("thread/goal/cleared", None, None)]
#[tokio::test]
async fn each_codex_goal_notification_draws_its_goal_row(
    #[case] method: &str,
    #[case] reported_status: Option<&str>,
    #[case] drawn_status: Option<&str>,
) {
    let mut session = TestCodexSession::start().await;
    let session_id =
        serde_json::to_value(session.task.record.session_id).expect("an id serializes");
    let agent_id =
        serde_json::to_value(session.task.record.lead_agent_id).expect("an id serializes");
    let params = match reported_status {
        Some(status) => json!({"threadId": TEST_THREAD, "goal": reported_goal(status)}),
        None => json!({"threadId": TEST_THREAD}),
    };
    session
        .scripted
        .script
        .send(&json!({"jsonrpc": "2.0", "method": method, "params": params}));
    session.task.handle_next().await;

    let expected = match (method, drawn_status) {
        ("thread/goal/cleared", _) => vec![json!({"sessionId": session_id, "agentId": agent_id})],
        (_, Some(status)) => vec![json!({
            "sessionId": session_id,
            "agentId": agent_id,
            "goal": {"text": "Ship the release notes"},
            "status": status,
        })],
        (_, None) => Vec::new(),
    };
    assert_eq!(session_event_payloads(&session), expected);
}

// A goal on a conversation other than the session's own, a helper's, draws no row for the lead,
// while the same goal on the session's own conversation does. Kill: the thread check removed.
#[tokio::test]
async fn a_goal_notification_for_another_conversation_draws_nothing() {
    let session = TestCodexSession::start().await;
    let delivery = Arc::clone(&session.task.calls.forks.delivery);
    let members = |thread_id: &str| -> Map<String, Value> {
        let frame = json!({"threadId": thread_id, "goal": reported_goal("active")});
        frame.as_object().cloned().expect("the frame is an object")
    };

    delivery
        .deliver_goal(
            &session.task.record,
            "thread/goal/updated",
            &members("helper-thread"),
        )
        .await;
    assert_eq!(session_event_payloads(&session), Vec::<Value>::new());

    delivery
        .deliver_goal(
            &session.task.record,
            "thread/goal/updated",
            &members(TEST_THREAD),
        )
        .await;
    assert_eq!(session_event_payloads(&session).len(), 1);
}
