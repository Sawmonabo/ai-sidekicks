use std::time::Duration;

use serde_json::{Value, json};
use sidekicks_contracts::mcp::governance::McpServerStatusChangedNotice;
use sidekicks_contracts::mcp::server::McpServerBindingRef;
use sidekicks_contracts::method::Method as _;
use sidekicks_ipc::call_fixtures::{context, request};
use sidekicks_ipc::registry::{Dispatch as _, EncodedFeed, Reply};
use sidekicks_ipc::stream::feed::CreditGate;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_envelope};
use sidekicks_store::events::log_service::EventLogAppendOptions;
use sidekicks_store::events::log_service::test_fixture::open_log;

use super::*;
use crate::daemon::schema::schema_parts;

/// Long enough for a frame that is coming to come, many windows over.
const QUIET: Duration = Duration::from_millis(250);

/// How long a read the test expects waits before the test fails instead of hanging.
const READ_BOUND: Duration = Duration::from_secs(10);

/// Appends a finished sign-in to `server_name` to the sentinel session's log.
async fn sign_in_completed(log: &EventLogService, server_name: &str) {
    let completed = serde_json::from_value(json!({
        "type": "mcp.server.signIn.completed",
        "payload": {
            "provider": "provider-a",
            "scope": "user",
            "serverName": server_name,
            "outcome": "success",
        },
    }))
    .expect("the test writes an mcp.server.signIn.completed event");
    log.append(
        test_envelope(*DAEMON_SCOPE_SENTINEL_SESSION_ID, &completed),
        EventLogAppendOptions::default(),
    )
    .await
    .expect("the append commits");
}

/// The next emission, as JSON; fails the test when none comes within `READ_BOUND`.
async fn next_json(feed: &mut Box<dyn EncodedFeed>, gate: &CreditGate) -> Value {
    let value = tokio::time::timeout(READ_BOUND, feed.next(gate))
        .await
        .expect("an emission comes in time")
        .expect("the stream reads")
        .expect("the stream goes on");
    serde_json::from_slice(&value.json).expect("the emission is JSON")
}

// A notice sent the moment the acknowledgment is in hand, before any read of the stream, is read,
// so nothing falls between the subscribe call and a first list; the log is followed from its head.
#[tokio::test]
async fn the_stream_reads_what_is_sent_after_the_acknowledgment_and_nothing_stored_before() {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await.service;
    sign_in_completed(&log, "before").await;
    let board = Arc::new(McpNoticeBoard::default());
    let mut builder = MethodRegistryBuilder::new();
    register_mcp_methods(&mut builder, Arc::clone(&log), Arc::clone(&board))
        .expect("the method registers");
    let reply = builder
        .freeze()
        .dispatch(
            request(McpSubscribe::DESCRIPTOR.method, Some(&json!({}))),
            context(1),
        )
        .await;
    let Ok(Reply::Subscription { mut feed, .. }) = reply else {
        panic!("mcp.subscribe answers a subscription");
    };

    let binding: McpServerBindingRef = serde_json::from_value(json!({
        "provider": "provider-a",
        "scope": "user",
        "serverName": "github",
    }))
    .expect("the test writes a binding ref");
    let notice: McpServerStatusChangedNotice = serde_json::from_value(json!({
        "type": "mcp.server.status.changed",
        "origin": "machineProbe",
        "provider": "provider-a",
        "scope": "user",
        "serverName": "github",
        "previousStatus": "unknown",
        "status": "connected",
    }))
    .expect("the test writes a probe notice");
    board.send_probe_notice(&binding, notice.clone());
    let gate = CreditGate::with_credit(1);
    assert_eq!(
        next_json(&mut feed, &gate).await,
        serde_json::to_value(&notice).expect("the notice is JSON")
    );

    sign_in_completed(&log, "after").await;
    let event = next_json(&mut feed, &gate).await;
    assert_eq!(event["type"], "mcp.server.signIn.completed");
    assert_eq!(event["payload"]["serverName"], "after");
    assert!(
        tokio::time::timeout(QUIET, feed.next(&gate)).await.is_err(),
        "the event stored before the call is not read"
    );
}
