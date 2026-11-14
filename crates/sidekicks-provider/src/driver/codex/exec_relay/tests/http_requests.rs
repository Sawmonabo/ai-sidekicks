//! Each connection's http requests on the relay's one executor: sent under request ids the relay
//! mints, each streamed body reaching only the request that asked for it, under its own id.

use serde_json::{Value, json};

use super::{
    ListeningRelay, admitted_socket, assert_quiet, initialize, listening_relay, next_forwarded,
    next_text, send_text,
};
use crate::driver::test_registry::new_session_id;

// The id Codex gives its first streamed request, the same on every connection.
const OWN_REQUEST: &str = "http-1";

// Two connections each stream a request under `http-1`; the executor reads two relay ids and
// writes the second's body ahead of the first's. Each connection reads its answer and then only
// its own body, in order, under `http-1`, and a delta after the first's last reaches no one.
// Killed by dropping the rewrite (the executor reads `http-1` twice), by deltas sent to every
// connection, and by an id kept past its last delta.
#[tokio::test]
async fn each_streamed_body_reaches_its_own_request() {
    let folder = tempfile::tempdir().expect("a test folder");
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
    let mut requests = Vec::new();
    for socket in &mut sockets {
        initialize(socket).await;
        send_text(socket, &streamed_request(2)).await;
        requests.push(next_forwarded(&mut fake).await);
    }
    let relay_ids: Vec<Value> = requests
        .iter()
        .map(|request| request["params"]["requestId"].clone())
        .collect();
    assert_ne!(relay_ids[0], relay_ids[1], "the requests collide");
    for relay_id in &relay_ids {
        let relay_id = relay_id.as_str().expect("a request id is a string");
        assert!(relay_id.starts_with("sidekicks-http-"), "{relay_id}");
    }
    for request in &requests {
        fake.write(&json!({ "id": request["id"], "result": headers() }))
            .await;
    }

    let bodies = [["Zmlyc3Q=", "b25l"], ["c2Vjb25k", "dHdv"]];
    for (relay_id, body) in relay_ids.iter().zip(&bodies).rev() {
        for (seq, chunk) in (1..).zip(body) {
            fake.write(&delta(relay_id, seq, chunk, seq == 2)).await;
        }
    }
    fake.write(&delta(&relay_ids[0], 3, "bGF0ZQ==", true)).await;
    for (socket, body) in sockets.iter_mut().zip(&bodies) {
        assert_eq!(
            next_text(socket).await,
            json!({ "id": 2, "result": headers() })
        );
        for (seq, chunk) in (1..).zip(body) {
            assert_eq!(
                next_text(socket).await,
                delta(&json!(OWN_REQUEST), seq, chunk, seq == 2)
            );
        }
        assert_quiet(socket).await;
    }
}

// A client's streamed `http/request` under `id` and its own request id.
fn streamed_request(id: u64) -> Value {
    json!({ "id": id, "method": "http/request", "params": {
        "method": "GET",
        "url": "https://example.com/events",
        "headers": [],
        "requestId": OWN_REQUEST,
        "streamResponse": true,
    }})
}

// The executor's answer to a streamed request: its headers, its body to follow.
fn headers() -> Value {
    json!({ "status": 200, "headers": [], "bodyBase64": "" })
}

// One body delta of the request `request_id`, the last when `done`.
fn delta(request_id: &Value, seq: u64, chunk: &str, done: bool) -> Value {
    json!({ "method": "http/request/bodyDelta", "params": {
        "requestId": request_id,
        "seq": seq,
        "deltaBase64": chunk,
        "done": done,
    }})
}
