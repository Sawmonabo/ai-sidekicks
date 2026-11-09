//! Each connection's open files on the relay's one executor: opened under handles the relay
//! mints, every later call reaching only the connection's own handle, and a dropped connection's
//! files, one still opening included, closed on the executor.

use serde_json::{Value, json};
use sidekicks_std::mutex_lock::lock;

use super::{
    ClientSocket, FakeExecutor, ListeningRelay, admitted_socket, assert_executor_quiet, initialize,
    listening_relay, next_forwarded, next_text, send_text,
};
use crate::bounded_poll::poll_until;
use crate::driver::test_registry::new_session_id;

// A handle id as Codex mints one, 32 hex characters, the same on both connections.
const OWN_HANDLE: &str = "0f3c5a7e9b1d4f60a2c4e6f8a0b2c4d6";

// Two connections open the same own handle and read under two relay handles; the second's read of
// a handle it never opened reaches the executor as unknown. The first closes one handle, opens
// another and leaves a third opening as it drops: the drop closes the open one, the third's late
// answer closes the third, and nothing else of either connection is closed. Killed by dropping the
// handle rewrite, by passing an unopened handle on as it came, by a drop that closes nothing or
// every connection's handles, by a close whose answer keeps the handle, by forgetting the open in
// flight at the drop, and by closing that open at the drop as well.
#[tokio::test]
async fn each_connection_owns_its_file_handles_and_a_drop_closes_its_own() {
    let folder = tempfile::tempdir().expect("a test folder");
    let ListeningRelay {
        relay,
        mut fake,
        url,
        presented,
    } = listening_relay(new_session_id(), folder.path()).await;
    let mut first = admitted_socket(&url, &presented).await;
    let mut second = admitted_socket(&url, &presented).await;
    initialize(&mut first).await;
    initialize(&mut second).await;

    let mut opens = Vec::new();
    for socket in [&mut first, &mut second] {
        send_text(socket, &open(2, OWN_HANDLE)).await;
        opens.push(next_forwarded(&mut fake).await);
    }
    let handles: Vec<Value> = opens
        .iter()
        .map(|open| open["params"]["handleId"].clone())
        .collect();
    assert_ne!(handles[0], handles[1], "the opens collide");
    for handle in &handles {
        let handle = handle.as_str().expect("a handle is a string");
        assert!(
            handle.starts_with("sidekicks-file-") && handle.len() <= 32,
            "{handle}"
        );
    }
    for open in opens.iter().rev() {
        answer_open(&mut fake, open).await;
    }
    for socket in [&mut first, &mut second] {
        assert_eq!(next_text(socket).await, opened(2, OWN_HANDLE));
    }

    send_text(&mut second, &read_block(3, OWN_HANDLE)).await;
    assert_eq!(
        next_forwarded(&mut fake).await["params"]["handleId"],
        handles[1]
    );
    send_text(&mut second, &read_block(4, "never-opened")).await;
    assert_eq!(
        next_forwarded(&mut fake).await["params"]["handleId"],
        "sidekicks-unknown"
    );

    send_text(
        &mut first,
        &json!({ "id": 3, "method": "fs/close", "params": { "handleId": OWN_HANDLE } }),
    )
    .await;
    let close = next_forwarded(&mut fake).await;
    assert_eq!(close["params"]["handleId"], handles[0]);
    fake.write(&json!({ "id": close["id"], "result": {} }))
        .await;
    assert_eq!(
        next_text(&mut first).await,
        json!({ "id": 3, "result": {} })
    );
    let open_handle = open_and_answer(&mut first, &mut fake, 4, "second-handle").await;
    send_text(&mut first, &open(5, "third-handle")).await;
    let opening = next_forwarded(&mut fake).await;

    let connections = || {
        lock(&relay.executor)
            .as_ref()
            .map_or(0, |executor| executor.connection_count())
    };
    first.close(None).await.expect("the client closes");
    poll_until(connections, |open| *open == 1).await;
    assert_closed(&next_forwarded(&mut fake).await, &open_handle);
    assert_executor_quiet(&mut fake).await;
    answer_open(&mut fake, &opening).await;
    assert_closed(
        &next_forwarded(&mut fake).await,
        &opening["params"]["handleId"],
    );
    assert_executor_quiet(&mut fake).await;

    send_text(&mut second, &read_block(5, OWN_HANDLE)).await;
    assert_eq!(
        next_forwarded(&mut fake).await["params"]["handleId"],
        handles[1]
    );
}

// Opens `own_handle` on `socket` under `id`, answers it as opened, reads the answer and answers
// the relay's handle for it.
async fn open_and_answer(
    socket: &mut ClientSocket,
    fake: &mut FakeExecutor,
    id: u64,
    own_handle: &str,
) -> Value {
    send_text(socket, &open(id, own_handle)).await;
    let open = next_forwarded(fake).await;
    answer_open(fake, &open).await;
    assert_eq!(next_text(socket).await, opened(id, own_handle));
    open["params"]["handleId"].clone()
}

// Answers the forwarded `open` as the executor does, naming its handle back.
async fn answer_open(fake: &mut FakeExecutor, open: &Value) {
    fake.write(&json!({ "id": open["id"], "result": { "handleId": open["params"]["handleId"] } }))
        .await;
}

// Fails unless `sent` is the relay's own `fs/close` of `handle`.
fn assert_closed(sent: &Value, handle: &Value) {
    assert_eq!(sent["method"], "fs/close", "{sent}");
    assert_eq!(sent["params"]["handleId"], *handle, "{sent}");
    assert!(
        sent["id"]
            .as_str()
            .is_some_and(|id| id.starts_with("sidekicks-relay-")),
        "{sent}"
    );
}

// A client's `fs/open` of a file under its own `handle` and `id`.
fn open(id: u64, handle: &str) -> Value {
    json!({ "id": id, "method": "fs/open", "params": {
        "handleId": handle,
        "path": "file:///tmp/notes.txt",
        "mode": "read",
        "sandbox": null,
    }})
}

// The answer a client reads to its open `id` of `handle`.
fn opened(id: u64, handle: &str) -> Value {
    json!({ "id": id, "result": { "handleId": handle } })
}

// A client's `fs/readBlock` of its own `handle` under `id`.
fn read_block(id: u64, handle: &str) -> Value {
    json!({ "id": id, "method": "fs/readBlock", "params": {
        "handleId": handle,
        "offset": 0,
        "len": 4,
    }})
}
