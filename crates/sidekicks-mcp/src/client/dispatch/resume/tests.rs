mod live;
mod restart;

use std::sync::Arc;

use serde_json::json;
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use tokio::time::{Duration, Instant, timeout};
use tokio_util::sync::CancellationToken;

use crate::client::connection::standing::McpStandingConnection;
use crate::client::dispatch::tests::{
    Fixture, StoredReceipt, receipt_without_task, silent_call_server, task_server,
};
use crate::client::dispatch::{McpCallCompletionError, McpToolDispatchError};
use crate::client::tasks::McpTaskContact::{
    AnsweredWithErrors, CancelRefused, ErrorsPersisted, Lost, NotConfigured, Reached, Reconfigured,
};
use crate::client::tasks::{McpServerEndpoint, McpToolCallEnd};
use crate::client::test_server::{
    Reply, Responder, board_accepted, board_answer, board_form, completed, contact, input_required,
    method_not_found, text_result, track_call, tracked_end, tracker_digest, v1_status_reply,
    v2_task_server, wait_for_contact,
};
use crate::sign_in::address_digest::{ServerAddressDigest, ServerAddressKey};

/// A fixture whose connections reach the server `tracker` at its address.
async fn fixture_at_address() -> Fixture {
    let mut fixture = Fixture::new().await;
    fixture.address_digest = Some(tracker_digest());
    fixture
}

/// The keyed digest of another address the session's server `tracker` can be configured at.
fn other_digest() -> ServerAddressDigest {
    ServerAddressKey::of_test_fill(1)
        .digest(&McpServerAddress::new("https://other.example.com/mcp").expect("an address"))
}

/// A 2025-11-25 server whose task `task-1` reads `working` at every poll.
fn working_task_server() -> Responder {
    task_server(|method, _| match method {
        "tasks/get" => v1_status_reply("working"),
        _ => method_not_found(),
    })
}

/// The receipt of task `task-1` on the 2025-11-25 server `tracker` at its address, at `status`.
fn address_task_receipt(status: &str, is_completed: bool) -> StoredReceipt {
    let endpoint = McpServerEndpoint::at_address(&tracker_digest());
    StoredReceipt {
        status: status.to_owned(),
        is_started: true,
        is_completed,
        task: ["task-1", "v1", "tracker", endpoint.as_str()].map(|column| Some(column.to_owned())),
    }
}

// Mutations: in `follow_across_reconnects`, return the `ConnectionClosed` end instead of waiting
// for the replacement, keep polling the closed connection, or resume before the replacement is
// published, so the follow never ends; in `poll_once`, go on polling a closed connection.
#[tokio::test(start_paused = true)]
async fn a_task_whose_connection_a_reconnect_replaces_is_followed_on_the_new_one_to_its_end() {
    let fixture = fixture_at_address().await;
    let (standing, old) = fixture.connect(working_task_server()).await;
    let contact = contact();
    let uncanceled = CancellationToken::new();

    let (dispatched, new) = tokio::join!(
        fixture
            .dispatch
            .call(&standing, track_call(), &contact, &uncanceled),
        async {
            old.wait_until(|old| !old.requests("tasks/get").is_empty())
                .await;
            // The Reconnect publishes the new connection, then closes the old one under the
            // follow.
            let (_, new) = fixture
                .connect(task_server(|method, _| match method {
                    "tasks/get" => v1_status_reply("completed"),
                    "tasks/result" => Reply::Answer(json!({ "result": text_result("tracked") })),
                    _ => method_not_found(),
                }))
                .await;
            new
        },
    );
    let (end, written) = dispatched.expect("the call is dispatched").complete().await;

    assert_eq!(end.expect("the call ends"), tracked_end());
    written.expect("the caller writes the end");
    assert_eq!(
        fixture.receipts(),
        [address_task_receipt("completed", true)]
    );
    assert_eq!(
        old.requests("tasks/get").len(),
        1,
        "no poll after the close"
    );
    assert_eq!(
        new.requests("tasks/get").len(),
        1,
        "the next poll is on the new one"
    );
    assert_eq!(*contact.borrow(), Reached);
}

// Mutation: give the re-bound follow a contact of its own in place of the task's watch's, so its
// first answered poll shows `Reached` where the refused stop stood.
#[tokio::test(start_paused = true)]
async fn a_refused_stop_still_reads_refused_after_an_outage_and_a_reconnect() {
    let fixture = fixture_at_address().await;
    let (standing, old) = fixture
        .connect(task_server(|method, earlier| match (method, earlier) {
            ("tasks/get", 0) => v1_status_reply("working"),
            ("tasks/get", _) => Reply::Silent,
            _ => method_not_found(),
        }))
        .await;
    let contact = contact();
    let cancellation = CancellationToken::new();

    let (dispatched, ()) = tokio::join!(
        fixture
            .dispatch
            .call(&standing, track_call(), &contact, &cancellation),
        async {
            old.wait_until(|old| old.requests("tasks/get").len() == 1)
                .await;
            cancellation.cancel();
            let mut seen = contact.subscribe();
            seen.wait_for(|state| *state == CancelRefused { is_from_stop: true })
                .await
                .expect("the contact stays open");
            seen.wait_for(|state| *state == Lost)
                .await
                .expect("the contact stays open");
            fixture
                .connect(task_server(|method, earlier| match (method, earlier) {
                    ("tasks/get", 0) => v1_status_reply("working"),
                    ("tasks/get", _) => v1_status_reply("completed"),
                    ("tasks/result", _) => {
                        Reply::Answer(json!({ "result": text_result("tracked") }))
                    }
                    _ => method_not_found(),
                }))
                .await;
        },
    );
    let (end, written) = dispatched.expect("the call is dispatched").complete().await;

    assert_eq!(end.expect("the call ends"), tracked_end());
    written.expect("the caller writes the end");
    assert_eq!(*contact.borrow(), CancelRefused { is_from_stop: true });
}

// Mutations: finish the task's watch at `ConnectionClosed`, or drop its asked keys, so the
// re-bound follow asks `k1` a second time; or send the answer over the old connection, or wait
// for a re-bind before sending it.
#[tokio::test(start_paused = true)]
async fn a_2026_07_28_tasks_open_question_is_kept_across_a_reconnect_and_answered_over_the_new_one()
{
    let fixture = fixture_at_address().await;
    let (standing, old) = fixture
        .connect(v2_task_server(|_, _, _| input_required(&["k1"])))
        .await;
    let contact = contact();
    let uncanceled = CancellationToken::new();

    let (dispatched, new) = tokio::join!(
        fixture
            .dispatch
            .call(&standing, track_call(), &contact, &uncanceled),
        async {
            fixture.card.wait_until_taken(1).await;
            let (_, new) = fixture
                .connect(v2_task_server(|_, updates, _| {
                    if updates == 0 {
                        input_required(&["k1"])
                    } else {
                        completed()
                    }
                }))
                .await;
            // A poll on the new connection reads `k1` still waiting, where a key asked again shows.
            new.wait_until(|new| !new.requests("tasks/get").is_empty())
                .await;
            fixture.card.answer_open(board_answer()).await;
            new
        },
    );
    let (end, written) = dispatched.expect("the call is dispatched").complete().await;

    assert_eq!(
        fixture.card.taken().len(),
        1,
        "the kept question is not asked again"
    );
    assert!(
        old.requests("tasks/update").is_empty(),
        "nothing is answered over the old connection"
    );
    let updates = new.requests("tasks/update");
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

// Mutations: in `wait_for_replacement`, leave the contact as it was while the server is
// reconfigured; in `V2TaskAnswer::send`, wait for a connection of the task's endpoint, send over
// whatever connection is live, or report the answer sent.
#[tokio::test(start_paused = true)]
async fn a_question_answered_while_its_servers_address_changed_fails_at_once_and_sends_nothing() {
    let fixture = fixture_at_address().await;
    let (standing, old) = fixture
        .connect(v2_task_server(|_, _, _| input_required(&["k1"])))
        .await;
    let contact = contact();
    let uncanceled = CancellationToken::new();

    let (dispatched, (other, answered)) = tokio::join!(
        fixture
            .dispatch
            .call(&standing, track_call(), &contact, &uncanceled),
        async {
            fixture.card.wait_until_taken(1).await;
            let (opened, other) = fixture
                .open(v2_task_server(|_, _, _| completed()), Some(&other_digest()))
                .await;
            fixture.client.add_connection(opened).await;
            let mut seen = contact.subscribe();
            seen.wait_for(|state| *state == Reconfigured)
                .await
                .expect("the contact stays open");
            let answered = timeout(
                Duration::from_secs(1),
                fixture.card.try_answer_open(board_answer()),
            )
            .await
            .expect("the answer fails at once");
            assert_eq!(
                fixture.card.open_questions().len(),
                1,
                "the question stays open to answer after the re-bind"
            );
            fixture.client.close_session(fixture.session_id).await;
            (other, answered)
        },
    );
    let (end, written) = dispatched.expect("the call is dispatched").complete().await;

    assert!(answered.is_err(), "the answer has no connection to go over");
    assert!(
        old.requests("tasks/update").is_empty(),
        "nothing is answered over the closed connection"
    );
    assert!(
        other.requests("tasks/update").is_empty(),
        "nothing is answered at another address"
    );
    assert!(
        other.requests("tasks/get").is_empty(),
        "nothing is polled at another address"
    );
    assert_eq!(
        end.expect("the call ends"),
        McpToolCallEnd::ConnectionClosed
    );
    assert!(matches!(written, Err(McpCallCompletionError::Settled)));
    let [stored] = <[_; 1]>::try_from(fixture.receipts()).expect("one receipt");
    assert_eq!(
        (stored.status.as_str(), stored.is_completed),
        ("unknown", true)
    );
}

// Mutations: in `wait_for_replacement`, leave the contact `Reached` while no connection is live,
// or read why none is only once, so the server added again at another address still reads
// `NotConfigured`; in `follow_across_reconnects`, end at `ConnectionClosed` without waiting; or
// leave the wait unraced against the session's close.
#[tokio::test(start_paused = true)]
async fn a_task_whose_server_is_no_longer_configured_reads_so_and_waits_until_the_close() {
    let fixture = fixture_at_address().await;
    let (standing, feed) = McpStandingConnection::new(CancellationToken::new());
    let (opened, server) = fixture
        .open(working_task_server(), fixture.address_digest.as_ref())
        .await;
    let connection = Arc::new(opened);
    feed.publish(Some(Arc::clone(&connection)));
    let contact = contact();
    let uncanceled = CancellationToken::new();

    let (dispatched, ()) = tokio::join!(
        fixture
            .dispatch
            .call(&standing, track_call(), &contact, &uncanceled),
        async {
            server
                .wait_until(|server| !server.requests("tasks/get").is_empty())
                .await;
            // The server is removed: no connection of it stays live.
            feed.publish(None);
            connection.close().await;
            wait_for_contact(&contact, NotConfigured).await;
            let polls = server.requests("tasks/get").len();
            tokio::time::sleep(Duration::from_secs(600)).await;
            assert_eq!(
                server.requests("tasks/get").len(),
                polls,
                "the wait polls nothing"
            );
            assert_eq!(*contact.borrow(), NotConfigured);
            assert_eq!(
                fixture.receipts(),
                [address_task_receipt("accepted", false)],
                "the task waits in flight"
            );
            let (elsewhere, _other) = fixture
                .open(working_task_server(), Some(&other_digest()))
                .await;
            feed.publish(Some(Arc::new(elsewhere)));
            wait_for_contact(&contact, Reconfigured).await;
            feed.close().await;
        },
    );
    let (end, written) = dispatched.expect("the call is dispatched").complete().await;

    assert_eq!(
        end.expect("the call ends"),
        McpToolCallEnd::ConnectionClosed
    );
    assert!(matches!(written, Err(McpCallCompletionError::Settled)));
    assert_eq!(fixture.receipts(), [address_task_receipt("unknown", true)]);
}

// Mutations: in `wait_for_connection`, run no clock while the connection that ended is still the
// one published, so the contact reads `Reached` with nothing polled; or start Lost's clock at the
// wait's start, so `Lost` shows 300 s after the close rather than after the last answered poll.
#[tokio::test(start_paused = true)]
async fn a_task_whose_connection_ends_with_no_reconnect_reads_lost_300_s_after_its_last_answer() {
    let fixture = fixture_at_address().await;
    let (standing, feed) = McpStandingConnection::new(CancellationToken::new());
    let (opened, server) = fixture
        .open(
            task_server(|method, earlier| match (method, earlier) {
                ("tasks/get", 0) => v1_status_reply("working"),
                ("tasks/get", _) => Reply::Silent,
                _ => method_not_found(),
            }),
            fixture.address_digest.as_ref(),
        )
        .await;
    let connection = Arc::new(opened);
    feed.publish(Some(Arc::clone(&connection)));
    let contact = contact();
    let uncanceled = CancellationToken::new();

    let (dispatched, ()) = tokio::join!(
        fixture
            .dispatch
            .call(&standing, track_call(), &contact, &uncanceled),
        async {
            // Every answer comes after this, so `Lost` is due no sooner than 300 s from here.
            let started = Instant::now();
            server
                .wait_until(|server| server.requests("tasks/get").len() > 1)
                .await;
            // Its polls go unanswered for 250 s, then its transport ends on its own: the
            // connection stays published, nothing replaces it.
            tokio::time::sleep_until(started + Duration::from_secs(250)).await;
            assert_eq!(
                *contact.borrow(),
                Reached,
                "unanswered polls under 300 s read reached"
            );
            connection.close().await;
            let mut seen = contact.subscribe();
            seen.wait_for(|state| *state == Lost)
                .await
                .expect("the contact stays open");
            let lost_after = started.elapsed();
            assert!(
                lost_after >= Duration::from_secs(300) && lost_after < Duration::from_secs(350),
                "lost 300 s after the last answer, not {lost_after:?}"
            );
            feed.close().await;
        },
    );
    let (end, written) = dispatched.expect("the call is dispatched").complete().await;

    assert_eq!(
        end.expect("the call ends"),
        McpToolCallEnd::ConnectionClosed
    );
    assert!(matches!(written, Err(McpCallCompletionError::Settled)));
    assert_eq!(fixture.receipts(), [address_task_receipt("unknown", true)]);
}

// Mutation: in `wait_for_connection`, write `Lost` at 300 s whatever cause the contact held, so it
// never reads `ErrorsPersisted`.
#[tokio::test(start_paused = true)]
async fn a_task_whose_server_answered_errors_reads_errors_persisted_when_its_wait_passes_300_s() {
    let fixture = fixture_at_address().await;
    let (standing, feed) = McpStandingConnection::new(CancellationToken::new());
    let (opened, _server) = fixture
        .open(
            task_server(|method, earlier| match (method, earlier) {
                ("tasks/get", 0) => v1_status_reply("working"),
                ("tasks/get", _) => Reply::Answer(
                    json!({ "error": { "code": -32603, "message": "Internal error" } }),
                ),
                _ => method_not_found(),
            }),
            fixture.address_digest.as_ref(),
        )
        .await;
    let connection = Arc::new(opened);
    feed.publish(Some(Arc::clone(&connection)));
    let contact = contact();
    let uncanceled = CancellationToken::new();

    let (dispatched, ()) = tokio::join!(
        fixture
            .dispatch
            .call(&standing, track_call(), &contact, &uncanceled),
        async {
            wait_for_contact(&contact, AnsweredWithErrors).await;
            // Its transport ends on its own while the errors show: nothing replaces it.
            connection.close().await;
            let mut seen = contact.subscribe();
            seen.wait_for(|state| *state == ErrorsPersisted)
                .await
                .expect("the contact stays open");
            feed.close().await;
        },
    );
    let (end, written) = dispatched.expect("the call is dispatched").complete().await;

    assert_eq!(
        end.expect("the call ends"),
        McpToolCallEnd::ConnectionClosed
    );
    assert!(matches!(written, Err(McpCallCompletionError::Settled)));
    assert_eq!(fixture.receipts(), [address_task_receipt("unknown", true)]);
}

// Mutation: in `wait_for_replacement`, read the client's stop as the session's close, writing the
// end unknown.
#[tokio::test(start_paused = true)]
async fn a_task_waiting_for_its_replacement_when_the_client_stops_stays_in_flight() {
    let fixture = fixture_at_address().await;
    let (standing, server) = fixture.connect(working_task_server()).await;
    let contact = contact();
    let uncanceled = CancellationToken::new();

    let (dispatched, ()) = tokio::join!(
        fixture
            .dispatch
            .call(&standing, track_call(), &contact, &uncanceled),
        async {
            // The task is accepted before its connection is replaced.
            server
                .wait_until(|server| !server.requests("tasks/get").is_empty())
                .await;
            let (opened, _other) = fixture
                .open(working_task_server(), Some(&other_digest()))
                .await;
            fixture.client.add_connection(opened).await;
            wait_for_contact(&contact, Reconfigured).await;
            fixture.client.stop().await;
        },
    );

    assert!(matches!(
        dispatched,
        Err(McpToolDispatchError::ClientStopping)
    ));
    assert_eq!(
        fixture.receipts(),
        [address_task_receipt("accepted", false)]
    );
}

// Mutation: in `call`, write the session's close row under the stop, which a backgrounded call
// takes too.
#[tokio::test(start_paused = true)]
async fn a_backgrounded_plain_call_cut_by_the_clients_stop_stays_in_flight() {
    let fixture = fixture_at_address().await;
    let (standing, server) = fixture.connect(silent_call_server()).await;
    let contact = contact();
    let uncanceled = CancellationToken::new();

    let (dispatched, ()) = tokio::join!(
        fixture
            .dispatch
            .call(&standing, track_call(), &contact, &uncanceled),
        async {
            server
                .wait_until(|server| server.requests("tools/call").len() == 1)
                .await;
            fixture.move_to_background("command-1");
            fixture.client.stop().await;
        },
    );

    assert!(matches!(
        dispatched,
        Err(McpToolDispatchError::ClientStopping)
    ));
    assert_eq!(
        fixture.receipts(),
        [receipt_without_task("accepted", false)]
    );
}

// Mutation: in `wait_for_replacement`, write the caller's cancel through the session's close,
// which completes a backgrounded call without its hand-off.
#[tokio::test(start_paused = true)]
async fn a_backgrounded_task_canceled_while_waiting_for_its_replacement_keeps_its_hand_off_owed() {
    let fixture = fixture_at_address().await;
    let (standing, feed) = McpStandingConnection::new(CancellationToken::new());
    let (opened, server) = fixture
        .open(working_task_server(), fixture.address_digest.as_ref())
        .await;
    let connection = Arc::new(opened);
    feed.publish(Some(Arc::clone(&connection)));
    let contact = contact();
    let cancellation = CancellationToken::new();

    let (dispatched, ()) = tokio::join!(
        fixture
            .dispatch
            .call(&standing, track_call(), &contact, &cancellation),
        async {
            server
                .wait_until(|server| !server.requests("tasks/get").is_empty())
                .await;
            fixture.move_to_background("command-1");
            feed.publish(None);
            connection.close().await;
            wait_for_contact(&contact, NotConfigured).await;
            cancellation.cancel();
        },
    );
    let (end, written) = dispatched.expect("the call is dispatched").complete().await;

    assert_eq!(
        end.expect("the call ends"),
        McpToolCallEnd::ConnectionClosed
    );
    assert!(
        matches!(written, Err(McpCallCompletionError::Write(_))),
        "a backgrounded call's end waits for its hand-off"
    );
    assert_eq!(
        fixture.receipts(),
        [address_task_receipt("accepted", false)],
        "the receipt stays in flight until handed over"
    );
}

// Mutation: in `call_tool`, await the end of the call's tracking, so a dispatch dropped there
// leaves the task's watch with nobody holding it and its question open.
#[tokio::test(start_paused = true)]
async fn a_dispatch_dropped_as_its_follow_leaves_the_tasks_watch_withdraws_the_tasks_question() {
    let fixture = fixture_at_address().await;
    let (standing, feed) = McpStandingConnection::new(CancellationToken::new());
    let (opened, server) = fixture
        .open(
            task_server(|method, earlier| match (method, earlier) {
                ("tasks/get", 0) => v1_status_reply("working"),
                ("tasks/get", _) => v1_status_reply("input_required"),
                ("tasks/result", _) => Reply::AskThenSilent {
                    request: live::task_elicitation("first"),
                },
                _ => method_not_found(),
            }),
            fixture.address_digest.as_ref(),
        )
        .await;
    let connection = Arc::new(opened);
    feed.publish(Some(Arc::clone(&connection)));
    let contact = contact();
    let uncanceled = CancellationToken::new();
    let mut call = Box::pin(
        fixture
            .dispatch
            .call(&standing, track_call(), &contact, &uncanceled),
    );

    let task_question = tokio::select! {
        _ = &mut call => panic!("the call ended before its connection closed"),
        held = async {
            server.wait_until(|server| server.requests("tools/call").len() == 1).await;
            // A question outside the task, asked under the call, which the call's end withdraws.
            let call_question = json!({
                "jsonrpc": "2.0",
                "id": "server-call",
                "method": "elicitation/create",
                "params": board_form(),
            });
            server
                .unasked
                .send(call_question.to_string())
                .expect("the server is running");
            fixture.card.wait_until_taken(1).await;
            // The task's question waits for its run behind the call's.
            fixture.card.wait_until_waiting(1).await;
            let task_question = fixture.card.waiting()[0].request_id.clone();
            // Held, so the end of the call's tracking would wait here if it awaited them.
            fixture.card.hold_withdrawals();
            feed.publish(None);
            connection.close().await;
            wait_for_contact(&contact, NotConfigured).await;
            task_question
        } => held,
    };
    drop(call);

    fixture.card.release_withdrawals();
    fixture.card.wait_until_withdrawn(&task_question).await;
}
