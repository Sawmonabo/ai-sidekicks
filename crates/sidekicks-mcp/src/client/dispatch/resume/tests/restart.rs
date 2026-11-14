//! A receipt the daemon's restart left in flight, resumed by the restart's sweep: a plain call's
//! and a stdio task's end unknown at once, a task at an address followed from a fresh poll, and a
//! 2025-11-25 task found waiting on input canceled before anything is held.

use std::sync::Arc;

use rstest::rstest;
use serde_json::json;
use sidekicks_provider::port::question::is_tool_server_request_id;
use tokio::sync::watch;
use tokio::time::Duration;
use tokio_util::sync::CancellationToken;

use super::live::task_elicitation;
use super::{address_task_receipt, fixture_at_address, working_task_server};
use crate::client::connection::standing::McpStandingConnection;
use crate::client::dispatch::tests::{Fixture, left_in_flight, task_server, tools_server};
use crate::client::dispatch::{McpCallCompletionError, McpDispatchedCall};
use crate::client::tasks::McpTaskContact::{CancelRefused, NotConfigured, Reached};
use crate::client::tasks::{McpServerEndpoint, McpTaskContact, McpTaskGeneration, McpToolCallEnd};
use crate::client::test_server::{
    Reply, Responder, board_accepted, board_answer, completed, contact, input_required,
    method_not_found, text_result, tracked_end, tracker_digest, v1_initialize_result,
    v1_status_reply, v2_task_server, wait_for_contact,
};
use crate::command_receipts::InFlightReceipt;

/// The receipt of a 2025-11-25 task on the tracker at its address, left in flight.
async fn v1_left_in_flight(fixture: &Fixture) -> InFlightReceipt {
    let endpoint = McpServerEndpoint::at_address(&tracker_digest());
    left_in_flight(fixture, Some((McpTaskGeneration::V1, endpoint))).await
}

/// Resumes `receipt` over `standing` as the restart's sweep does.
async fn resume(
    fixture: &Fixture,
    standing: &McpStandingConnection,
    receipt: InFlightReceipt,
    contact: &watch::Sender<McpTaskContact>,
    cancellation: &CancellationToken,
) -> McpDispatchedCall {
    Box::pin(
        fixture
            .dispatch
            .resume(standing, receipt, contact, cancellation),
    )
    .await
    .expect("the receipt is resumed")
}

/// A 2025-11-25 server's error answer with `code`.
fn error_reply(code: i64) -> Reply {
    Reply::Answer(json!({ "error": { "code": code, "message": "not now" } }))
}

/// The answer to `tasks/result` once the task ended: the result [`text_result`] `tracked`.
fn tracked_result() -> Reply {
    Reply::Answer(json!({ "result": text_result("tracked") }))
}

/// A 2025-11-25 server whose task `task-1` waits on input at every poll, its held `tasks/result`
/// asking [`task_elicitation`] and never answering, and whose `tasks/cancel` is answered through
/// `cancel_reply` with how many came before.
fn waiting_task_server(mut cancel_reply: impl FnMut(usize) -> Reply + Send + 'static) -> Responder {
    task_server(move |method, earlier| match method {
        "tasks/get" => v1_status_reply("input_required"),
        "tasks/result" => Reply::AskThenSilent {
            request: task_elicitation("first"),
        },
        "tasks/cancel" => cancel_reply(earlier),
        _ => method_not_found(),
    })
}

// Mutations: in `resume`, follow a stdio receipt's task as one at an address (it is polled and
// never ends), or end a receipt with no task otherwise than unknown.
#[rstest]
#[case::plain_call(true, None)]
#[case::stdio_task(false, Some((McpTaskGeneration::V1, McpServerEndpoint::stdio())))]
#[tokio::test(start_paused = true)]
async fn a_receipt_with_no_task_or_a_stdio_task_ends_unknown_at_once_sending_nothing(
    #[case] is_at_address: bool,
    #[case] task: Option<(McpTaskGeneration, McpServerEndpoint)>,
) {
    let fixture = if is_at_address {
        fixture_at_address().await
    } else {
        Fixture::new().await
    };
    let (standing, server) = fixture.connect(working_task_server()).await;
    let contact = contact();
    let receipt = left_in_flight(&fixture, task).await;

    let dispatched = resume(
        &fixture,
        &standing,
        receipt,
        &contact,
        &CancellationToken::new(),
    )
    .await;
    let (end, written) = dispatched.complete().await;

    assert_eq!(
        end.expect("the call ends"),
        McpToolCallEnd::ConnectionClosed
    );
    written.expect("the caller writes the end");
    for method in ["tasks/get", "tasks/cancel", "tasks/result"] {
        assert!(server.requests(method).is_empty(), "no {method} is sent");
    }
    assert!(fixture.card.taken().is_empty(), "nothing is asked");
    let [stored] = <[_; 1]>::try_from(fixture.receipts()).expect("one receipt");
    assert_eq!(
        (stored.status.as_str(), stored.is_completed),
        ("unknown", true)
    );
}

// Mutations: in `resume`, end a task with no live connection at once instead of waiting, or leave
// the contact `Reached` while it waits.
#[tokio::test(start_paused = true)]
async fn a_task_resumed_with_no_connection_of_its_server_reads_so_and_waits_for_one() {
    let fixture = fixture_at_address().await;
    let (standing, feed) = McpStandingConnection::new(CancellationToken::new());
    let contact = contact();
    let receipt = v1_left_in_flight(&fixture).await;

    let uncanceled = CancellationToken::new();
    let (dispatched, _server) = tokio::join!(
        resume(&fixture, &standing, receipt, &contact, &uncanceled),
        async {
            wait_for_contact(&contact, NotConfigured).await;
            tokio::time::sleep(Duration::from_mins(10)).await;
            assert_eq!(
                fixture.receipts(),
                [address_task_receipt("accepted", false)],
                "the task waits in flight"
            );
            let (opened, server) = fixture
                .open(
                    task_server(|method, _| match method {
                        "tasks/get" => v1_status_reply("completed"),
                        "tasks/result" => tracked_result(),
                        _ => method_not_found(),
                    }),
                    fixture.address_digest.as_ref(),
                )
                .await;
            feed.publish(Some(Arc::new(opened)));
            server
        },
    );
    let (end, written) = dispatched.complete().await;

    assert_eq!(end.expect("the call ends"), tracked_end());
    written.expect("the caller writes the end");
    assert_eq!(*contact.borrow(), Reached, "the contact before the wait");
    assert_eq!(
        fixture.receipts(),
        [address_task_receipt("completed", true)]
    );
}

// Mutations: in `resume_task`, skip a 2026-07-28 task's inputs after a restart, or adopt asked
// keys no watch holds.
#[tokio::test(start_paused = true)]
async fn a_2026_07_28_task_resumed_waiting_on_input_asks_it_anew() {
    let fixture = fixture_at_address().await;
    let (standing, server) = fixture
        .connect(v2_task_server(|_, updates, _| {
            if updates == 0 {
                input_required(&["k1"])
            } else {
                completed()
            }
        }))
        .await;
    let contact = contact();
    let endpoint = McpServerEndpoint::at_address(&tracker_digest());
    let receipt = left_in_flight(&fixture, Some((McpTaskGeneration::V2, endpoint))).await;

    let uncanceled = CancellationToken::new();
    let (dispatched, ()) = tokio::join!(
        resume(&fixture, &standing, receipt, &contact, &uncanceled),
        async {
            fixture.card.wait_until_taken(1).await;
            fixture.card.answer_open(board_answer()).await;
        },
    );
    let (end, written) = dispatched.complete().await;

    let taken = fixture.card.taken();
    assert_eq!(taken.len(), 1, "the input is asked once");
    assert!(
        is_tool_server_request_id(&taken[0].request_id),
        "under an id the client mints"
    );
    let updates = server.requests("tasks/update");
    assert_eq!(updates.len(), 1);
    assert_eq!(
        updates[0].1["params"]["inputResponses"]["k1"],
        board_accepted()
    );
    assert_eq!(end.expect("the call ends"), tracked_end());
    written.expect("the caller writes the end");
    let [stored] = <[_; 1]>::try_from(fixture.receipts()).expect("one receipt");
    assert_eq!(
        (stored.status.as_str(), stored.is_completed),
        ("completed", true)
    );
}

// Mutation: in `resume`, follow the task outside the dispatch's race, so the session's close is
// not read and no `tasks/cancel` is sent.
#[tokio::test(start_paused = true)]
async fn a_resumed_task_whose_session_closes_is_canceled_and_written_by_its_dispatch() {
    let fixture = fixture_at_address().await;
    let (standing, server) = fixture
        .connect(task_server(|method, _| match method {
            "tasks/get" => v1_status_reply("working"),
            "tasks/cancel" => v1_status_reply("cancelled"),
            _ => method_not_found(),
        }))
        .await;
    let contact = contact();
    let receipt = v1_left_in_flight(&fixture).await;

    let uncanceled = CancellationToken::new();
    let (dispatched, ()) = tokio::join!(
        resume(&fixture, &standing, receipt, &contact, &uncanceled),
        async {
            server
                .wait_until(|server| !server.requests("tasks/get").is_empty())
                .await;
            fixture.client.close_session(fixture.session_id).await;
        },
    );
    let (end, written) = dispatched.complete().await;

    assert_eq!(server.requests("tasks/cancel").len(), 1);
    assert_eq!(end.expect("the call ends"), McpToolCallEnd::Canceled);
    assert!(matches!(written, Err(McpCallCompletionError::Settled)));
    assert_eq!(fixture.receipts(), [address_task_receipt("failed", true)]);
}

// Mutations: in `resume`, ignore a canceled token; in `cancel_followed_task`, leave the restart's
// own cancel owed, so a second `tasks/cancel` goes out at the first poll reading `input_required`
// and a refusal reads as no stop's; or leave a refused stop's contact `Reached`.
#[rstest]
#[case::taken(
    v1_status_reply("cancelled"),
    "cancelled",
    McpToolCallEnd::Canceled,
    "failed",
    Reached
)]
#[case::refused(
    method_not_found(),
    "completed",
    tracked_end(),
    "completed",
    CancelRefused { is_from_stop: true }
)]
#[tokio::test(start_paused = true)]
async fn a_task_resumed_under_a_stop_is_canceled_once_and_followed_to_its_end(
    #[case] cancel_answer: Reply,
    #[case] status_after_first: &'static str,
    #[case] expected_end: McpToolCallEnd,
    #[case] expected_status: &str,
    #[case] expected_contact: McpTaskContact,
) {
    let fixture = fixture_at_address().await;
    let mut cancel_answer = Some(cancel_answer);
    let (standing, server) = fixture
        .connect(task_server(move |method, earlier| {
            match (method, earlier) {
                ("tasks/get", 0) => v1_status_reply("input_required"),
                ("tasks/get", _) => v1_status_reply(status_after_first),
                ("tasks/result", 0) => Reply::Silent,
                ("tasks/result", _) => tracked_result(),
                ("tasks/cancel", _) => cancel_answer.take().unwrap_or_else(method_not_found),
                _ => method_not_found(),
            }
        }))
        .await;
    let contact = contact();
    let receipt = v1_left_in_flight(&fixture).await;
    let stop = CancellationToken::new();
    stop.cancel();

    let dispatched = resume(&fixture, &standing, receipt, &contact, &stop).await;
    let (end, written) = dispatched.complete().await;

    assert_eq!(
        server.requests("tasks/cancel").len(),
        1,
        "one cancel, the stop's"
    );
    assert_eq!(end.expect("the call ends"), expected_end);
    written.expect("the caller writes the end");
    assert_eq!(*contact.borrow(), expected_contact);
    assert_eq!(
        fixture.receipts(),
        [address_task_receipt(expected_status, true)]
    );
}

// Mutations: in `poll_once`, hold `tasks/result` before the restart's cancel is answered; in
// `follow_task`, owe no cancel after a restart; in `cancel_after_restart`, settle the cancel when
// its send fails, or hold `tasks/result` until it is sent again; in `outcome_of`, write `failed`
// for a lost input.
#[rstest]
#[case::taken(|_| v1_status_reply("cancelled"), 1)]
#[case::sent_again_after_a_failed_send(
    |earlier| if earlier == 0 { error_reply(-32603) } else { v1_status_reply("cancelled") },
    2
)]
#[tokio::test(start_paused = true)]
async fn a_task_resumed_waiting_on_input_is_canceled_before_its_result_is_held(
    #[case] cancel_reply: fn(usize) -> Reply,
    #[case] expected_cancels: usize,
) {
    let fixture = fixture_at_address().await;
    let (standing, server) = fixture.connect(waiting_task_server(cancel_reply)).await;
    let contact = contact();
    let receipt = v1_left_in_flight(&fixture).await;

    let dispatched = resume(
        &fixture,
        &standing,
        receipt,
        &contact,
        &CancellationToken::new(),
    )
    .await;
    let (end, written) = dispatched.complete().await;

    assert_eq!(server.requests("tasks/cancel").len(), expected_cancels);
    assert!(
        server.requests("tasks/result").is_empty(),
        "no result is held while the cancel is owed"
    );
    assert!(
        fixture.card.taken().is_empty(),
        "the server's question never reaches the card"
    );
    assert_eq!(end.expect("the call ends"), McpToolCallEnd::InputLost);
    written.expect("the caller writes the end");
    assert_eq!(fixture.receipts(), [address_task_receipt("unknown", true)]);
}

// Mutation: in `cancel_after_restart`, keep the cancel owed when a poll reads another status, so
// the later `input_required` cancels again instead of holding the result.
#[tokio::test(start_paused = true)]
async fn a_failed_restart_cancel_is_owed_no_more_once_the_task_stops_waiting_on_input() {
    let fixture = fixture_at_address().await;
    let (standing, server) = fixture
        .connect(task_server(|method, earlier| match (method, earlier) {
            ("tasks/get", 0 | 2) => v1_status_reply("input_required"),
            ("tasks/get", 1) => v1_status_reply("working"),
            ("tasks/get", _) => v1_status_reply("completed"),
            ("tasks/result", 0) => Reply::Silent,
            ("tasks/result", _) => tracked_result(),
            ("tasks/cancel", _) => error_reply(-32603),
            _ => method_not_found(),
        }))
        .await;
    let contact = contact();
    let receipt = v1_left_in_flight(&fixture).await;

    let dispatched = resume(
        &fixture,
        &standing,
        receipt,
        &contact,
        &CancellationToken::new(),
    )
    .await;
    let (end, written) = dispatched.complete().await;

    assert_eq!(
        server.requests("tasks/cancel").len(),
        1,
        "only the failed one"
    );
    assert_eq!(
        server.requests("tasks/result").len(),
        2,
        "held at the later input_required, then read at the end"
    );
    assert_eq!(end.expect("the call ends"), tracked_end());
    written.expect("the caller writes the end");
    assert_eq!(
        fixture.receipts(),
        [address_task_receipt("completed", true)]
    );
}

// Mutation: in `cancel_waiting_task`, end the task `InputLost` on the cancel's `-32602` without
// reading it.
#[tokio::test(start_paused = true)]
async fn a_restart_cancel_of_a_task_that_ended_meanwhile_reads_its_result_once() {
    let fixture = fixture_at_address().await;
    let (standing, server) = fixture
        .connect(task_server(|method, earlier| match (method, earlier) {
            ("tasks/get", 0) => v1_status_reply("input_required"),
            ("tasks/get", _) => v1_status_reply("completed"),
            ("tasks/result", _) => tracked_result(),
            ("tasks/cancel", _) => error_reply(-32602),
            _ => method_not_found(),
        }))
        .await;
    let contact = contact();
    let receipt = v1_left_in_flight(&fixture).await;

    let dispatched = resume(
        &fixture,
        &standing,
        receipt,
        &contact,
        &CancellationToken::new(),
    )
    .await;
    let (end, written) = dispatched.complete().await;

    assert_eq!(server.requests("tasks/cancel").len(), 1);
    assert_eq!(
        server.requests("tasks/get").len(),
        2,
        "one read after the cancel"
    );
    assert_eq!(server.requests("tasks/result").len(), 1);
    assert_eq!(end.expect("the call ends"), tracked_end());
    written.expect("the caller writes the end");
    assert_eq!(
        fixture.receipts(),
        [address_task_receipt("completed", true)]
    );
}

// Mutations: in `cancel_after_restart`, write a refusal as a stop's (`is_from_stop` true), leave
// the contact as it was, or end the follow at the refusal; or keep the cancel owed after it, so no
// result is held.
#[tokio::test(start_paused = true)]
async fn a_restart_cancel_a_server_cannot_take_reads_as_no_stop_and_the_follow_goes_on() {
    let fixture = fixture_at_address().await;
    let mut initialize = v1_initialize_result();
    initialize["capabilities"]["tasks"]
        .as_object_mut()
        .expect("the tasks capability is an object")
        .remove("cancel");
    let (standing, server) = fixture
        .connect(tools_server(
            initialize,
            json!({ "taskSupport": "required" }),
            |method, _| match method {
                "tasks/get" => v1_status_reply("input_required"),
                "tasks/result" => Reply::AskThenSilent {
                    request: task_elicitation("first"),
                },
                _ => method_not_found(),
            },
        ))
        .await;
    let contact = contact();
    let receipt = v1_left_in_flight(&fixture).await;

    let uncanceled = CancellationToken::new();
    let (dispatched, ()) = tokio::join!(
        resume(&fixture, &standing, receipt, &contact, &uncanceled),
        async {
            fixture.card.wait_until_taken(1).await;
            assert_eq!(
                *contact.borrow(),
                CancelRefused {
                    is_from_stop: false
                }
            );
            fixture.client.close_session(fixture.session_id).await;
        },
    );
    let (end, written) = dispatched.complete().await;

    assert!(
        server.requests("tasks/cancel").is_empty(),
        "a server that cancels no task is sent none"
    );
    assert_eq!(
        server.requests("tasks/result").len(),
        1,
        "the follow holds the result"
    );
    assert_eq!(
        end.expect("the call ends"),
        McpToolCallEnd::ConnectionClosed
    );
    assert!(matches!(written, Err(McpCallCompletionError::Settled)));
    assert_eq!(fixture.receipts(), [address_task_receipt("unknown", true)]);
}
