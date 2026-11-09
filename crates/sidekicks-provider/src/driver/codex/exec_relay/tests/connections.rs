//! Many connections onto the relay's one executor: each answered apart under its own ids, a
//! closed one's answers reaching no one, and every one answered by the executor's end and kept
//! open.

use std::sync::Arc;

use serde_json::{Value, json};
use sidekicks_std::mutex_lock::lock;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::{
    ListeningRelay, admitted_socket, assert_quiet, initialize, initialized_executor,
    listening_relay, next_forwarded, next_line, next_text, relay_for, send_text, wait_until,
};
use crate::driver::test_registry::new_session_id;

// Two connections that each send `initialize` under id 1 and are each answered from the relay's
// own, with no `initialize` reaching the executor; then each sends a request under id 2, which
// the executor reads under two distinct relay ids, and the executor answers the second first.
// Each connection receives exactly its own result under id 2. Killed by answers keyed by the
// client's own id (the two collide), by every answer sent to the newest connection (the first
// connection's read of its result times out), and by the client's id not put back.
#[tokio::test]
async fn two_connections_are_each_answered_under_their_own_ids() {
    let folder = tempfile::tempdir().expect("a test folder");
    // The relay is kept to the end, so no connection closes for its own drop.
    let ListeningRelay {
        relay: _relay,
        mut fake,
        url,
        presented,
    } = listening_relay(new_session_id(), folder.path()).await;
    let mut sockets = [
        admitted_socket(&url, &presented).await,
        admitted_socket(&url, &presented).await,
    ];
    for socket in &mut sockets {
        initialize(socket).await;
    }

    let paths = ["file:///first", "file:///second"];
    for (socket, path) in sockets.iter_mut().zip(paths) {
        send_text(socket, &metadata_request(2, path)).await;
    }
    // The first lines the executor reads are the two requests: no `initialize` came before them.
    let mut forwarded = [
        next_forwarded(&mut fake).await,
        next_forwarded(&mut fake).await,
    ];
    forwarded.sort_by_key(|request| request["params"]["path"].to_string());
    for (request, path) in forwarded.iter().zip(paths) {
        assert_eq!(request["method"], "fs/getMetadata");
        assert_eq!(request["params"]["path"], path);
        assert!(
            request["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("sidekicks-client-")),
            "the request reached the executor under {}",
            request["id"]
        );
    }
    assert_ne!(forwarded[0]["id"], forwarded[1]["id"]);

    for (request, modified_at_ms) in forwarded.iter().zip([1, 2]).rev() {
        fake.write(&json!({ "id": request["id"], "result": metadata(modified_at_ms) }))
            .await;
    }
    for (socket, modified_at_ms) in sockets.iter_mut().zip([1, 2]) {
        assert_eq!(
            next_text(socket).await,
            json!({ "id": 2, "result": metadata(modified_at_ms) })
        );
        assert_quiet(socket).await;
    }
}

// The first of two connections sends a request and closes; the executor answers it after the
// close. The second's next request, under the same id, is answered, and the second never receives
// the first's answer, which the executor wrote ahead of the second's. Killed by a detach that
// removes every connection, and by an answer with no connection handed to another one.
#[tokio::test]
async fn a_closed_connections_answer_reaches_no_one_and_the_other_goes_on() {
    let folder = tempfile::tempdir().expect("a test folder");
    let ListeningRelay {
        relay,
        mut fake,
        url,
        presented,
    } = listening_relay(new_session_id(), folder.path()).await;
    let mut closing = admitted_socket(&url, &presented).await;
    let mut staying = admitted_socket(&url, &presented).await;
    initialize(&mut closing).await;
    initialize(&mut staying).await;
    let connections = || {
        lock(&relay.executor)
            .as_ref()
            .map_or(0, |executor| executor.connection_count())
    };
    assert_eq!(connections(), 2);

    send_text(&mut closing, &metadata_request(2, "file:///closed")).await;
    let orphan = next_forwarded(&mut fake).await;
    closing.close(None).await.expect("the client closes");
    wait_until(|| connections() == 1).await;
    fake.write(&json!({ "id": orphan["id"], "result": metadata(1) }))
        .await;

    send_text(&mut staying, &metadata_request(2, "file:///staying")).await;
    let request = next_forwarded(&mut fake).await;
    assert_eq!(request["params"]["path"], "file:///staying");
    assert_ne!(request["id"], orphan["id"]);
    fake.write(&json!({ "id": request["id"], "result": metadata(2) }))
        .await;
    assert_eq!(
        next_text(&mut staying).await,
        json!({ "id": 2, "result": metadata(2) }),
        "the closed connection's answer reached the other"
    );
    assert_quiet(&mut staying).await;
}

// Once the executor's output closes, each of two connections is answered its own request the
// executor left unanswered, under its own id with the error naming the end, and never the other's;
// each stays open, and its next request is answered with the same error. Killed by owed answers
// sent to one connection or under the relay's ids, by connections closed at the end, and by a
// later request passed on to the ended executor, each failing a read or the quiet wait.
#[tokio::test]
async fn the_executors_end_answers_every_connection_its_own_requests_and_stays_open() {
    let folder = tempfile::tempdir().expect("a test folder");
    // The relay is kept to the end, so no connection closes for its own drop.
    let ListeningRelay {
        relay: _relay,
        mut fake,
        url,
        presented,
    } = listening_relay(new_session_id(), folder.path()).await;
    let mut sockets = [
        admitted_socket(&url, &presented).await,
        admitted_socket(&url, &presented).await,
    ];
    let paths = ["file:///first", "file:///second"];
    for (socket, path) in sockets.iter_mut().zip(paths) {
        initialize(socket).await;
        send_text(socket, &metadata_request(2, path)).await;
        assert_eq!(next_forwarded(&mut fake).await["params"]["path"], path);
    }

    drop(fake);

    let ended_answer = |id: u64| {
        json!({ "id": id, "error": {
            "code": -32603,
            "message": "The Codex executor running this service's commands ended; the service \
                        starts a new one.",
        }})
    };
    for socket in &mut sockets {
        assert_eq!(next_text(socket).await, ended_answer(2));
    }
    for (socket, path) in sockets.iter_mut().zip(paths) {
        send_text(socket, &metadata_request(3, path)).await;
        assert_eq!(next_text(socket).await, ended_answer(3));
        assert_quiet(socket).await;
    }
}

// A client's `fs/getMetadata` of `path` under `id`.
fn metadata_request(id: u64, path: &str) -> Value {
    json!({ "id": id, "method": "fs/getMetadata", "params": { "path": path, "sandbox": null } })
}

// An `fs/getMetadata` result told apart by `modified_at_ms`.
fn metadata(modified_at_ms: i64) -> Value {
    json!({
        "isDirectory": false,
        "isFile": true,
        "isSymlink": false,
        "size": 1,
        "createdAtMs": 0,
        "modifiedAtMs": modified_at_ms,
    })
}

// A connection whose queue toward its socket stays full is let go, its socket told to close,
// and the executor's next line for another connection still reaches it. Killed by the executor's
// reader waiting on a full connection's queue, which holds every later line.
#[tokio::test]
async fn a_connection_that_stops_reading_holds_up_no_other() {
    let folder = tempfile::tempdir().expect("a test folder");
    let relay = relay_for(new_session_id(), folder.path());
    let (executor, mut fake) = initialized_executor().await;
    relay.take_executor(Arc::clone(&executor));
    let (stalled_client, _never_read) = mpsc::channel(1);
    let stalled_closed = CancellationToken::new();
    let (executor, stalled) = relay
        .attach_client(stalled_client, stalled_closed.clone())
        .expect("an executor runs");
    let (client, mut received) = mpsc::channel(16);
    let (_, reading) = relay
        .attach_client(client, CancellationToken::new())
        .expect("an executor runs");
    let start = |id: u64, process: &str| {
        json!({ "id": id, "method": "process/start", "params": {
            "processId": process,
            "argv": ["/bin/true"],
            "cwd": "file:///tmp",
            "env": {},
            "tty": false,
            "arg0": null,
        }})
        .to_string()
    };

    for (connection, id, process) in [
        (stalled, 1, "first"),
        (stalled, 2, "second"),
        (reading, 3, "third"),
    ] {
        relay
            .take_client_message(&executor, connection, start(id, process))
            .await;
        let sent = fake.next_sent().await;
        let relay_process = sent["params"]["processId"].clone();
        fake.write(&json!({ "id": sent["id"], "result": { "processId": relay_process } }))
            .await;
    }

    assert_eq!(next_line(&mut received).await["id"], 3);
    assert!(
        stalled_closed.is_cancelled(),
        "the stalled connection is let go"
    );
}
