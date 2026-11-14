use std::sync::Arc;

use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use tokio::time::{Duration, timeout};

use super::{MCP_RESTART_SWEEP_STATEMENT_CAPACITY, McpReceiptSession, McpRestartSweep};
use crate::client::dispatch::tests::{Fixture, StoredReceipt, left_in_flight, task_server};
use crate::client::tasks::{McpServerEndpoint, McpTaskGeneration};
use crate::client::test_server::{
    Reply, method_not_found, text_result, tracker_digest, v1_status_reply,
};

/// The sweep over `fixture`'s client, dispatch and database.
fn sweep(fixture: &Fixture) -> McpRestartSweep {
    McpRestartSweep::new(
        Arc::clone(&fixture.client),
        Arc::clone(&fixture.dispatch),
        Arc::new(DatabaseReadPool::new(
            fixture.database.path(),
            MCP_RESTART_SWEEP_STATEMENT_CAPACITY,
        )),
    )
}

/// The one receipt, once its end is written by the sweep's resume, which runs on the client's
/// tracker after `start` returns.
async fn ended_receipt(fixture: &Fixture) -> StoredReceipt {
    let ended = async {
        loop {
            let [receipt] = <[_; 1]>::try_from(fixture.receipts()).expect("one receipt");
            if receipt.is_completed {
                return receipt;
            }
            // Short steps of the paused clock, so no resume's own timer comes due while the
            // writer's thread writes.
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    };
    timeout(Duration::from_mins(10), ended)
        .await
        .expect("the receipt's end is written")
}

/// The task server's endpoint: the tracker at its address, or a stdio server.
fn endpoint(is_at_address: bool) -> McpServerEndpoint {
    if is_at_address {
        McpServerEndpoint::at_address(&tracker_digest())
    } else {
        McpServerEndpoint::stdio()
    }
}

// Mutations: resume a `Damaged` receipt (the server is polled); pass a live token under `Stopped`
// (it waits for a connection); stand a `Missing` receipt on an open standing connection (it
// waits).
#[rstest]
#[case::no_task_in_a_session_that_continues(false, None, false, McpReceiptSession::Continues, true)]
#[case::no_task_in_no_session(false, None, false, |_| McpReceiptSession::Missing, true)]
#[case::a_stdio_task_in_a_session_that_continues(
    false,
    Some(McpTaskGeneration::V1),
    true,
    McpReceiptSession::Continues,
    true
)]
#[case::a_task_at_an_address_in_no_session(
    true,
    Some(McpTaskGeneration::V1),
    false,
    |_| McpReceiptSession::Missing,
    true
)]
#[case::a_task_at_an_address_its_stop_asked_for_with_no_connection(
    true,
    Some(McpTaskGeneration::V1),
    false,
    McpReceiptSession::Stopped,
    true
)]
#[case::a_task_at_an_address_in_a_damaged_session(
    true,
    Some(McpTaskGeneration::V1),
    true,
    |_| McpReceiptSession::Damaged,
    false
)]
#[case::a_task_at_an_address_in_a_session_that_continues_with_no_connection(
    true,
    Some(McpTaskGeneration::V1),
    false,
    McpReceiptSession::Continues,
    false
)]
#[tokio::test(start_paused = true)]
async fn a_receipt_ends_by_its_session(
    #[case] is_at_address: bool,
    #[case] task: Option<McpTaskGeneration>,
    #[case] is_connected: bool,
    #[case] receipt_session: fn(SessionId) -> McpReceiptSession,
    #[case] is_written: bool,
) {
    let mut fixture = Fixture::new().await;
    if is_at_address {
        fixture.address_digest = Some(tracker_digest());
    }
    // Held, so a live connection stays published for the whole sweep.
    let connected = if is_connected {
        Some(
            fixture
                .connect(task_server(|method, _| match method {
                    "tasks/get" => v1_status_reply("working"),
                    _ => method_not_found(),
                }))
                .await,
        )
    } else {
        None
    };
    let task = task.map(|generation| (generation, endpoint(is_at_address)));
    left_in_flight(&fixture, task).await;
    let session = receipt_session(fixture.session_id);

    sweep(&fixture)
        .start(move |_, _| Ok(session))
        .await
        .expect("the receipts in flight are read");

    let stored = if is_written {
        ended_receipt(&fixture).await
    } else {
        // Past the 300 s after which a waiting resume's contact reads its server lost.
        tokio::time::sleep(Duration::from_secs(400)).await;
        let [stored] = <[_; 1]>::try_from(fixture.receipts()).expect("one receipt");
        stored
    };
    let expected = if is_written {
        ("unknown", true)
    } else {
        ("accepted", false)
    };
    assert_eq!((stored.status.as_str(), stored.is_completed), expected);
    if let Some((_, server)) = &connected {
        for method in ["tasks/get", "tasks/cancel", "tasks/result"] {
            assert!(server.requests(method).is_empty(), "no {method} is sent");
        }
    }
}

// Mutation: leave the end unwritten (no `complete()`), so the receipt stays in flight and the
// second sweep resumes it again.
#[tokio::test(start_paused = true)]
async fn a_swept_task_resolves_once_over_two_sweeps() {
    let mut fixture = Fixture::new().await;
    fixture.address_digest = Some(tracker_digest());
    // Held, so the server answers for both sweeps.
    let (_standing, server) = fixture
        .connect(task_server(|method, _| match method {
            "tasks/get" => v1_status_reply("completed"),
            "tasks/result" => Reply::Answer(json!({ "result": text_result("tracked") })),
            _ => method_not_found(),
        }))
        .await;
    left_in_flight(&fixture, Some((McpTaskGeneration::V1, endpoint(true)))).await;
    let session_id = fixture.session_id;
    let sweep = sweep(&fixture);

    sweep
        .start(move |_, _| Ok(McpReceiptSession::Continues(session_id)))
        .await
        .expect("the receipts in flight are read");
    let first = ended_receipt(&fixture).await;
    sweep
        .start(move |_, _| Ok(McpReceiptSession::Continues(session_id)))
        .await
        .expect("the receipts in flight are read");
    tokio::time::sleep(Duration::from_secs(1)).await;

    assert_eq!(
        (first.status.as_str(), first.is_completed),
        ("completed", true)
    );
    assert_eq!(
        server.requests("tasks/get").len(),
        1,
        "the second sweep finds nothing in flight"
    );
    let [stored] = <[_; 1]>::try_from(fixture.receipts()).expect("one receipt");
    assert_eq!(stored, first);
}
