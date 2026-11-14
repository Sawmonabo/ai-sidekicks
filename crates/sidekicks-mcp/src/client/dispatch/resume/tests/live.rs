//! A 2025-11-25 task waiting on input when a Reconnect re-binds it: its question kept across the
//! close, the server's re-ask, and the bound on the wait for it.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use rstest::rstest;
use serde_json::{Value, json};
use tokio::sync::watch;
use tokio::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

use super::{address_task_receipt, fixture_at_address};
use crate::client::connection::McpServerConnection;
use crate::client::connection::standing::{McpStandingConnection, McpStandingConnectionFeed};
use crate::client::dispatch::McpCallCompletionError;
use crate::client::dispatch::tests::{Fixture, task_server};
use crate::client::tasks::McpTaskContact::{DidNotAskAgain, NotConfigured, Reached};
use crate::client::tasks::{McpTaskContact, McpToolCallEnd};
use crate::client::test_server::{
    Reply, Responder, TestServer, board_accepted, board_answer, board_form, contact,
    method_not_found, text_result, track_call, tracked_end, v1_status_reply, v1_task,
    wait_for_contact,
};

/// The elicitation [`board_form`] a 2025-11-25 server sends for task `task-1`, its `_meta` also
/// carrying the progress token `progress`, which differs between asks of one form.
pub(super) fn task_elicitation(progress: &str) -> Value {
    let mut params = board_form();
    params["_meta"] = json!({
        "io.modelcontextprotocol/related-task": { "taskId": "task-1" },
        "progressToken": progress,
    });
    json!({ "method": "elicitation/create", "params": params })
}

/// A 2025-11-25 server whose task `task-1` waits on input, its held `tasks/result` asking
/// [`task_elicitation`] and never answering.
fn asking_task_server() -> Responder {
    task_server(|method, _| match method {
        "tasks/get" => v1_status_reply("input_required"),
        "tasks/result" => Reply::AskThenSilent {
            request: task_elicitation("first"),
        },
        _ => method_not_found(),
    })
}

/// The answer to `tasks/result` once the task ended: the result [`text_result`] `tracked`.
fn tracked_result() -> Reply {
    Reply::Answer(json!({ "result": text_result("tracked") }))
}

/// A session's standing connection fed by hand, publishing a first connection to the tracker at
/// its address, which answers through `responder`.
async fn connect_by_hand(
    fixture: &Fixture,
    responder: Responder,
) -> (
    McpStandingConnection,
    McpStandingConnectionFeed,
    Arc<McpServerConnection>,
    TestServer,
) {
    let (standing, feed) = McpStandingConnection::new(CancellationToken::new());
    let (opened, server) = fixture
        .open(responder, fixture.address_digest.as_ref())
        .await;
    let connection = Arc::new(opened);
    feed.publish(Some(Arc::clone(&connection)));
    (standing, feed, connection, server)
}

/// Closes `connection` with no connection of its server left live, as a Reconnect's close does
/// before its replacement is published, and waits until the follow waits for the replacement.
async fn close_unreplaced(
    feed: &McpStandingConnectionFeed,
    connection: &McpServerConnection,
    contact: &watch::Sender<McpTaskContact>,
) {
    feed.publish(None);
    connection.close().await;
    wait_for_contact(contact, NotConfigured).await;
}

/// A re-bound 2025-11-25 server whose task waits on input, its first held `tasks/result` never
/// answering, until `is_done` is set, then completes.
fn reasked_task_server(is_done: &Arc<AtomicBool>) -> Responder {
    let is_done = Arc::clone(is_done);
    task_server(move |method, earlier| match (method, earlier) {
        ("tasks/get", _) if is_done.load(Ordering::SeqCst) => v1_status_reply("completed"),
        ("tasks/get", _) => v1_status_reply("input_required"),
        ("tasks/result", 0) => Reply::Silent,
        ("tasks/result", _) => tracked_result(),
        _ => method_not_found(),
    })
}

/// Has `server` ask [`task_elicitation`] again under the request id `server-reask`, the same form
/// under another progress token, once the follow polls it, and waits for the client's answer.
async fn reask(server: &TestServer) {
    server
        .wait_until(|server| !server.requests("tasks/get").is_empty())
        .await;
    let mut reask = task_elicitation("second");
    reask["jsonrpc"] = json!("2.0");
    reask["id"] = json!("server-reask");
    server
        .unasked
        .send(reask.to_string())
        .expect("the server is running");
    server
        .wait_until(|server| server.answer_to("server-reask").is_some())
        .await;
}

/// Publishes a connection to the tracker at its address answering through `responder`, as a
/// Reconnect's replacement.
async fn replace(
    fixture: &Fixture,
    feed: &McpStandingConnectionFeed,
    responder: Responder,
) -> TestServer {
    let (opened, server) = fixture
        .open(responder, fixture.address_digest.as_ref())
        .await;
    feed.publish(Some(Arc::new(opened)));
    server
}

// Mutations: in `create_elicitation`, withdraw a task's question on the closing connection's
// cancel (nothing open after the close); in `ask_v1_task_question`, ask the re-ask as a fresh
// question or compare its `_meta` (two taken); in `V1TaskAnswer`, drop an answer no request
// waits on, or settle it before the re-ask (nothing open after the answer).
#[tokio::test(start_paused = true)]
async fn a_kept_question_stays_open_across_a_reconnect_and_its_answer_goes_to_the_servers_re_ask() {
    let fixture = fixture_at_address().await;
    let (standing, feed, connection, old) = connect_by_hand(&fixture, asking_task_server()).await;
    let contact = contact();
    let uncanceled = CancellationToken::new();
    let is_done = Arc::new(AtomicBool::new(false));

    let (dispatched, new) = tokio::join!(
        fixture
            .dispatch
            .call(&standing, track_call(), &contact, &uncanceled),
        async {
            fixture.card.wait_until_taken(1).await;
            close_unreplaced(&feed, &connection, &contact).await;
            assert_eq!(
                fixture.card.open_questions().len(),
                1,
                "the close leaves the question open"
            );
            fixture.card.answer_open(board_answer()).await;
            assert_eq!(
                fixture.card.open_questions().len(),
                1,
                "the answer is kept, the question open"
            );
            let new = replace(&fixture, &feed, reasked_task_server(&is_done)).await;
            reask(&new).await;
            is_done.store(true, Ordering::SeqCst);
            new
        },
    );
    let (end, written) = dispatched.expect("the call is dispatched").complete().await;

    let reask_answer = new
        .answer_to("server-reask")
        .expect("the re-ask is answered");
    assert_eq!(reask_answer["result"], board_accepted());
    assert!(
        old.answer_to("server-1").is_none(),
        "no answer reaches the old connection"
    );
    assert_eq!(
        fixture.card.taken().len(),
        1,
        "the kept question is the card's one question"
    );
    assert_eq!(end.expect("the call ends"), tracked_end());
    written.expect("the caller writes the end");
    assert_eq!(
        fixture.receipts(),
        [address_task_receipt("completed", true)]
    );
    assert_eq!(*contact.borrow(), Reached);
}

// Mutation: in `settle_kept_answer_later`, only log a failed settle, so the question stays open
// with nobody left to withdraw it.
#[tokio::test(start_paused = true)]
async fn a_kept_answer_whose_settle_fails_has_its_question_withdrawn() {
    let fixture = fixture_at_address().await;
    let (standing, feed, connection, _old) = connect_by_hand(&fixture, asking_task_server()).await;
    let contact = contact();
    let uncanceled = CancellationToken::new();
    let is_done = Arc::new(AtomicBool::new(false));

    let (dispatched, ()) = tokio::join!(
        fixture
            .dispatch
            .call(&standing, track_call(), &contact, &uncanceled),
        async {
            fixture.card.wait_until_taken(1).await;
            close_unreplaced(&feed, &connection, &contact).await;
            let kept = fixture.card.answer_open(board_answer()).await.request_id;
            fixture.card.fail_settles();
            let new = replace(&fixture, &feed, reasked_task_server(&is_done)).await;
            reask(&new).await;
            fixture.card.wait_until_withdrawn(&kept).await;
            is_done.store(true, Ordering::SeqCst);
        },
    );
    let (end, written) = dispatched.expect("the call is dispatched").complete().await;

    assert!(
        fixture.card.open_questions().is_empty(),
        "no question is left open"
    );
    assert_eq!(end.expect("the call ends"), tracked_end());
    written.expect("the caller writes the end");
}

/// The server's re-bound task whose first poll reads `working`, then completes.
fn another_status_server(method: &str, earlier: usize) -> Reply {
    match (method, earlier) {
        ("tasks/get", 0) => v1_status_reply("working"),
        ("tasks/get", _) => v1_status_reply("completed"),
        ("tasks/result", _) => tracked_result(),
        _ => method_not_found(),
    }
}

/// The server's re-bound task asking another form at its first `input_required`, then completing.
fn another_form_server(method: &str, earlier: usize) -> Reply {
    match (method, earlier) {
        ("tasks/get", 0..3) => v1_status_reply("input_required"),
        ("tasks/get", _) => v1_status_reply("completed"),
        ("tasks/result", 0) => {
            let mut request = task_elicitation("second");
            request["params"]["message"] = json!("Which project?");
            Reply::AskThenSilent { request }
        }
        ("tasks/result", _) => tracked_result(),
        _ => method_not_found(),
    }
}

// Mutations: in `keep_reask_bound`, leave the kept question open when a poll reads another status
// first, or write no contact for a kept answer then lost; in `ask_v1_task_question`, write no
// `DidNotAskAgain` at a re-ask of another form, or let it take the kept question.
#[rstest]
#[case::another_status(another_status_server, 1)]
#[case::another_form(another_form_server, 2)]
#[tokio::test(start_paused = true)]
async fn a_kept_question_the_server_moves_on_from_is_withdrawn_and_its_kept_answer_reads_lost(
    #[case] replacement: fn(&str, usize) -> Reply,
    #[case] expected_taken: usize,
) {
    let fixture = fixture_at_address().await;
    let (standing, feed, connection, _old) = connect_by_hand(&fixture, asking_task_server()).await;
    let contact = contact();
    let uncanceled = CancellationToken::new();

    let (dispatched, kept) = tokio::join!(
        fixture
            .dispatch
            .call(&standing, track_call(), &contact, &uncanceled),
        async {
            fixture.card.wait_until_taken(1).await;
            close_unreplaced(&feed, &connection, &contact).await;
            let kept = fixture.card.answer_open(board_answer()).await.request_id;
            replace(&fixture, &feed, task_server(replacement)).await;
            kept
        },
    );
    let (end, written) = dispatched.expect("the call is dispatched").complete().await;

    assert!(
        fixture.card.withdrawals().contains(&kept),
        "the kept question is withdrawn"
    );
    assert_eq!(fixture.card.taken().len(), expected_taken);
    assert_eq!(
        *contact.borrow(),
        DidNotAskAgain {
            has_undelivered_answer: true
        }
    );
    assert_eq!(end.expect("the call ends"), tracked_end());
    written.expect("the caller writes the end");
}

/// The answer to the bound's `tasks/cancel`: taken, the task `cancelled`.
fn cancel_taken() -> Reply {
    Reply::Answer(json!({ "result": v1_task("cancelled") }))
}

/// The answer to the bound's `tasks/cancel` for a task that completed meanwhile: `-32602`.
fn cancel_of_an_ended_task() -> Reply {
    Reply::Answer(json!({ "error": { "code": -32602, "message": "task ended" } }))
}

// Mutations: no bound, or none for a follow that kept a question (the follow runs past 30
// minutes); a bound measured from anything but the first poll on the new connection; the kept
// question left open at the bound; `DidNotAskAgain` not written or its kept answer read
// delivered; no `tasks/cancel` at the bound; `failed` written for the lost input; or `unknown`
// written on `-32602` with no read of the task.
#[rstest]
#[case::taken(cancel_taken, McpToolCallEnd::InputLost, "unknown")]
#[case::task_ended_meanwhile(cancel_of_an_ended_task, tracked_end(), "completed")]
#[tokio::test(start_paused = true)]
async fn a_kept_question_not_asked_again_in_300_s_answered_is_withdrawn_and_its_task_canceled(
    #[case] cancel_reply: fn() -> Reply,
    #[case] expected_end: McpToolCallEnd,
    #[case] expected_status: &str,
) {
    let fixture = fixture_at_address().await;
    let (standing, feed, connection, _old) = connect_by_hand(&fixture, asking_task_server()).await;
    let contact = contact();
    let uncanceled = CancellationToken::new();
    let cancels = Arc::new(AtomicUsize::new(0));
    let responder = {
        let cancels = Arc::clone(&cancels);
        task_server(move |method, earlier| match (method, earlier) {
            ("tasks/get", _) if cancels.load(Ordering::SeqCst) > 0 => v1_status_reply("completed"),
            ("tasks/get", _) => v1_status_reply("input_required"),
            ("tasks/result", 0) => Reply::Silent,
            ("tasks/result", _) => tracked_result(),
            ("tasks/cancel", _) => {
                cancels.fetch_add(1, Ordering::SeqCst);
                cancel_reply()
            }
            _ => method_not_found(),
        })
    };

    let dispatched_at = Instant::now();
    let (dispatched, (new, kept)) = tokio::join!(
        fixture
            .dispatch
            .call(&standing, track_call(), &contact, &uncanceled),
        async {
            fixture.card.wait_until_taken(1).await;
            close_unreplaced(&feed, &connection, &contact).await;
            let kept = fixture.card.answer_open(board_answer()).await.request_id;
            (replace(&fixture, &feed, responder).await, kept)
        },
    );
    let (end, written) = dispatched.expect("the call is dispatched").complete().await;
    assert!(
        dispatched_at.elapsed() < Duration::from_mins(30),
        "the bound ends the wait"
    );

    let first_poll = new.requests("tasks/get")[0].0;
    let cancel_sent = new.requests("tasks/cancel");
    assert_eq!(cancel_sent.len(), 1);
    let bound = cancel_sent[0].0 - first_poll;
    assert!(
        (Duration::from_secs(300)..Duration::from_secs(310)).contains(&bound),
        "canceled 300 s answered after the first poll, not {bound:?}"
    );
    assert!(
        fixture.card.withdrawals().contains(&kept),
        "the kept question is withdrawn"
    );
    assert!(
        fixture.card.open_questions().is_empty(),
        "no question is left open"
    );
    assert_eq!(
        *contact.borrow(),
        DidNotAskAgain {
            has_undelivered_answer: true
        }
    );
    assert_eq!(end.expect("the call ends"), expected_end);
    written.expect("the caller writes the end");
    assert_eq!(
        fixture.receipts(),
        [address_task_receipt(expected_status, true)]
    );
}

// Mutations: the bound measured on wall time, or counting an outage (canceled at 300 s); no
// bound when no question was kept (the follow runs past 30 minutes); or the kept answer read as
// undelivered with none kept.
#[tokio::test(start_paused = true)]
async fn the_bound_counts_no_outage_and_holds_with_no_question_kept() {
    let fixture = fixture_at_address().await;
    let (standing, feed, connection, old) = connect_by_hand(
        &fixture,
        task_server(|method, _| match method {
            "tasks/get" => v1_status_reply("working"),
            _ => method_not_found(),
        }),
    )
    .await;
    let contact = contact();
    let uncanceled = CancellationToken::new();
    let first_poll: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
    let responder = {
        let first_poll = Arc::clone(&first_poll);
        task_server(move |method, _| match method {
            "tasks/get" => {
                let started = *first_poll
                    .lock()
                    .expect("never poisoned")
                    .get_or_insert_with(Instant::now);
                // Ten minutes without an answer, 100 s into the bound.
                if (100..700).contains(&started.elapsed().as_secs()) {
                    Reply::Silent
                } else {
                    v1_status_reply("input_required")
                }
            }
            "tasks/result" => Reply::Silent,
            "tasks/cancel" => cancel_taken(),
            _ => method_not_found(),
        })
    };

    let dispatched_at = Instant::now();
    let (dispatched, new) = tokio::join!(
        fixture
            .dispatch
            .call(&standing, track_call(), &contact, &uncanceled),
        async {
            old.wait_until(|old| !old.requests("tasks/get").is_empty())
                .await;
            close_unreplaced(&feed, &connection, &contact).await;
            replace(&fixture, &feed, responder).await
        },
    );
    let (end, written) = dispatched.expect("the call is dispatched").complete().await;
    assert!(
        dispatched_at.elapsed() < Duration::from_mins(30),
        "the bound ends the wait"
    );

    let started = first_poll
        .lock()
        .expect("never poisoned")
        .expect("the new connection was polled");
    let cancel_sent = new.requests("tasks/cancel");
    assert_eq!(cancel_sent.len(), 1);
    let bound = cancel_sent[0].0 - started;
    assert!(
        (Duration::from_mins(15)..Duration::from_secs(1_000)).contains(&bound),
        "the outage is not counted, so the cancel comes 300 s answered in, not {bound:?}"
    );
    assert_eq!(
        *contact.borrow(),
        DidNotAskAgain {
            has_undelivered_answer: false
        }
    );
    assert_eq!(end.expect("the call ends"), McpToolCallEnd::InputLost);
    written.expect("the caller writes the end");
    assert_eq!(fixture.receipts(), [address_task_receipt("unknown", true)]);
}

// Mutation: in `keep_reask_bound`, keep the held `tasks/result` once the bound's cancel fails to
// send, so an ask of a task owed a cancel could still reach the card.
#[tokio::test(start_paused = true)]
async fn a_bounds_cancel_that_fails_lets_the_held_result_go_until_the_cancel_is_answered() {
    let fixture = fixture_at_address().await;
    let (standing, feed, connection, old) = connect_by_hand(
        &fixture,
        task_server(|method, _| match method {
            "tasks/get" => v1_status_reply("working"),
            _ => method_not_found(),
        }),
    )
    .await;
    let contact = contact();
    let uncanceled = CancellationToken::new();

    let dispatched_at = Instant::now();
    let (dispatched, new) = tokio::join!(
        fixture
            .dispatch
            .call(&standing, track_call(), &contact, &uncanceled),
        async {
            old.wait_until(|old| !old.requests("tasks/get").is_empty())
                .await;
            close_unreplaced(&feed, &connection, &contact).await;
            replace(
                &fixture,
                &feed,
                task_server(|method, earlier| match (method, earlier) {
                    ("tasks/get", _) => v1_status_reply("input_required"),
                    ("tasks/result", _) => Reply::Silent,
                    ("tasks/cancel", 0) => Reply::Answer(
                        json!({ "error": { "code": -32603, "message": "the server is busy" } }),
                    ),
                    ("tasks/cancel", _) => cancel_taken(),
                    _ => method_not_found(),
                }),
            )
            .await
        },
    );
    let (end, written) = dispatched.expect("the call is dispatched").complete().await;
    assert!(
        dispatched_at.elapsed() < Duration::from_mins(30),
        "the bound ends the wait"
    );

    let cancels = new.requests("tasks/cancel");
    assert_eq!(cancels.len(), 2, "the failed cancel is sent again");
    let held = new.requests("tasks/result");
    assert_eq!(held.len(), 1, "nothing is held while the cancel is owed");
    let held_id = held[0].1["id"].clone();
    let (let_go_at, _) = new
        .requests("notifications/cancelled")
        .into_iter()
        .find(|(_, message)| message["params"]["requestId"] == held_id)
        .expect("the held result is let go");
    assert!(
        let_go_at < cancels[1].0,
        "the held result is let go before the cancel is sent again"
    );
    assert_eq!(end.expect("the call ends"), McpToolCallEnd::InputLost);
    written.expect("the caller writes the end");
}

// Mutations: end the follow at a refused cancel, or write `CancelRefused` over `DidNotAskAgain`;
// send the bound's cancel again at each poll once refused.
#[tokio::test(start_paused = true)]
async fn a_bound_whose_cancel_is_refused_follows_on_until_the_sessions_close() {
    let fixture = fixture_at_address().await;
    let (standing, feed, connection, _old) = connect_by_hand(&fixture, asking_task_server()).await;
    let contact = contact();
    let uncanceled = CancellationToken::new();

    let (dispatched, new) = tokio::join!(
        fixture
            .dispatch
            .call(&standing, track_call(), &contact, &uncanceled),
        async {
            fixture.card.wait_until_taken(1).await;
            close_unreplaced(&feed, &connection, &contact).await;
            fixture.card.answer_open(board_answer()).await;
            let new = replace(
                &fixture,
                &feed,
                task_server(|method, earlier| match (method, earlier) {
                    ("tasks/get", _) => v1_status_reply("input_required"),
                    ("tasks/result", _) => Reply::Silent,
                    _ => method_not_found(),
                }),
            )
            .await;
            tokio::time::sleep(Duration::from_secs(320)).await;
            assert_eq!(new.requests("tasks/cancel").len(), 1, "the bound's cancel");
            assert_eq!(
                *contact.borrow(),
                DidNotAskAgain {
                    has_undelivered_answer: true
                }
            );
            let polls = new.requests("tasks/get").len();
            tokio::time::sleep(Duration::from_secs(60)).await;
            assert!(
                new.requests("tasks/get").len() > polls,
                "the follow goes on"
            );
            assert_eq!(new.requests("tasks/cancel").len(), 1, "the bound is spent");
            feed.close().await;
            new
        },
    );
    let (end, written) = dispatched.expect("the call is dispatched").complete().await;

    assert_eq!(
        new.requests("tasks/cancel").len(),
        2,
        "the session's close asks once more"
    );
    assert_eq!(
        end.expect("the call ends"),
        McpToolCallEnd::ConnectionClosed
    );
    assert!(matches!(written, Err(McpCallCompletionError::Settled)));
    assert_eq!(fixture.receipts(), [address_task_receipt("unknown", true)]);
}
