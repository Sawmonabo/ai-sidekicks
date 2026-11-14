//! Each connection's processes on the relay's one executor: run under the relay's own ids, every
//! message about one reaching only the connection that started it.

use futures::SinkExt as _;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

use super::{
    ClientSocket, FakeExecutor, ListeningRelay, admitted_socket, assert_quiet, initialize,
    listening_relay, next_forwarded, next_text, send_text,
};
use crate::driver::test_registry::new_session_id;

// The id Codex gives its first tool server's process, the same on every connection.
const OWN_PROCESS: &str = "mcp-stdio-1";

// Two connections each start `mcp-stdio-1`; the executor reads two starts under two relay ids, and
// each connection reads its start's answer, its process's output and its exit under its own id,
// and never the other's; each one's read reaches the executor under its own process's relay id.
// Killed by dropping the rewrite: the second start reaches the executor under the first's id.
#[tokio::test]
async fn each_connection_owns_its_process_ids() {
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
    let mut relay_processes = Vec::new();
    for socket in &mut sockets {
        initialize(socket).await;
        relay_processes.push(start_own_process(socket, &mut fake).await);
    }
    assert_ne!(relay_processes[0], relay_processes[1], "the starts collide");

    for (relay_process, chunk) in relay_processes.iter().zip(["Zmlyc3Q=", "c2Vjb25k"]).rev() {
        fake.write(&output(relay_process, chunk)).await;
    }
    for (socket, chunk) in sockets.iter_mut().zip(["Zmlyc3Q=", "c2Vjb25k"]) {
        assert_eq!(next_text(socket).await, output(&json!(OWN_PROCESS), chunk));
    }
    for (socket, relay_process) in sockets.iter_mut().zip(&relay_processes) {
        send_text(socket, &read(3, OWN_PROCESS)).await;
        let forwarded = next_forwarded(&mut fake).await;
        assert_eq!(forwarded["params"]["processId"], *relay_process);
    }
    let exited = |process: &Value| {
        json!({
            "method": "process/exited",
            "params": { "processId": process, "seq": 2, "exitCode": 0 },
        })
    };
    fake.write(&exited(&relay_processes[1])).await;
    assert_eq!(
        next_text(&mut sockets[1]).await,
        exited(&json!(OWN_PROCESS))
    );
    for socket in &mut sockets {
        assert_quiet(socket).await;
    }
}

// The second connection names the first's process by the first's own id and by its relay id; both
// reach the executor as an id no process has, so the executor's unknown-process answer comes back
// to the second. Killed by passing an id the connection never started on as it came, which
// reaches the first's process.
#[tokio::test]
async fn a_process_a_connection_never_started_reaches_no_other() {
    let folder = tempfile::tempdir().expect("a test folder");
    let ListeningRelay {
        relay: _relay,
        mut fake,
        url,
        presented,
    } = listening_relay(new_session_id(), folder.path()).await;
    let mut owner = admitted_socket(&url, &presented).await;
    let mut other = admitted_socket(&url, &presented).await;
    initialize(&mut owner).await;
    initialize(&mut other).await;
    let relay_process = start_own_process(&mut owner, &mut fake).await;

    let named = [OWN_PROCESS, relay_process.as_str().expect("a relay id")];
    for (id, process) in (2..).zip(named) {
        send_text(&mut other, &read(id, process)).await;
        let forwarded = next_forwarded(&mut fake).await;
        assert_eq!(forwarded["params"]["processId"], "sidekicks-unknown");
        let refusal = json!({ "code": -32600, "message": "unknown process id sidekicks-unknown" });
        fake.write(&json!({ "id": forwarded["id"], "error": refusal }))
            .await;
        assert_eq!(
            next_text(&mut other).await,
            json!({ "id": id, "error": refusal })
        );
    }
    let terminate = json!({
        "id": 4,
        "method": "process/terminate",
        "params": { "processId": OWN_PROCESS },
    });
    send_text(&mut other, &terminate).await;
    let forwarded = next_forwarded(&mut fake).await;
    assert_eq!(forwarded["params"]["processId"], "sidekicks-unknown");
}

// The executor asks about the first connection's process: the ask reaches the first alone under
// its own id, the second's answer to it never reaches the executor and the first's does. An ask
// about a process no connection owns, and one the first leaves unanswered when it closes, are each
// denied by the relay at once. Killed by an ask handed to every connection, by an answer taken
// from a connection the ask was not sent to, and by an ask left waiting with no one to answer it.
#[tokio::test]
async fn a_policy_ask_reaches_its_process_alone_and_is_denied_once_none_can_answer() {
    let folder = tempfile::tempdir().expect("a test folder");
    let ListeningRelay {
        relay: _relay,
        mut fake,
        url,
        presented,
    } = listening_relay(new_session_id(), folder.path()).await;
    let mut owner = admitted_socket(&url, &presented).await;
    let mut other = admitted_socket(&url, &presented).await;
    initialize(&mut owner).await;
    initialize(&mut other).await;
    let relay_process = start_own_process(&mut owner, &mut fake).await;

    fake.write(&policy_request(7, &relay_process)).await;
    assert_eq!(
        next_text(&mut owner).await,
        policy_request(7, &json!(OWN_PROCESS))
    );
    assert_quiet(&mut other).await;
    let allowed = json!({ "id": 7, "result": { "decision": { "type": "allow" } } });
    let owners = json!({ "id": 7, "result": { "decision": { "type": "deny", "reason": "no" } } });
    send_text(&mut other, &allowed).await;
    send_text(&mut owner, &owners).await;
    assert_eq!(next_forwarded(&mut fake).await, owners);

    fake.write(&policy_request(8, &json!("sidekicks-process-99")))
        .await;
    assert_eq!(next_forwarded(&mut fake).await, denied(8));

    fake.write(&policy_request(9, &relay_process)).await;
    assert_eq!(
        next_text(&mut owner).await,
        policy_request(9, &json!(OWN_PROCESS))
    );
    owner.close(None).await.expect("the client closes");
    assert_eq!(next_forwarded(&mut fake).await, denied(9));
    assert_quiet(&mut other).await;
}

// A request for a method the executor does not serve is answered `-32601`, a line that is no
// message `-32600` and a request whose params do not read `-32602` under its own id, none reaching
// the executor; a notification other than `initialized`, even one naming a served method, is
// dropped, so the executor's connection stays open and the next served request is the first line
// it reads. Killed by passing an unserved request or a notification on, which the executor reads
// first, by passing on a line that is no message, and by refusing mistyped params under id -1.
#[tokio::test]
async fn refuses_what_the_executor_does_not_serve() {
    let folder = tempfile::tempdir().expect("a test folder");
    let ListeningRelay {
        relay: _relay,
        mut fake,
        url,
        presented,
    } = listening_relay(new_session_id(), folder.path()).await;
    let mut socket = admitted_socket(&url, &presented).await;
    initialize(&mut socket).await;

    send_text(
        &mut socket,
        &json!({ "id": 2, "method": "thread/start", "params": {} }),
    )
    .await;
    let refused = next_text(&mut socket).await;
    assert_eq!(refused["id"], 2);
    assert_eq!(refused["error"]["code"], -32601);
    for notification in [
        json!({ "method": "process/cancel", "params": {} }),
        json!({ "method": "fs/readFile", "params": { "path": "file:///etc/hosts" } }),
    ] {
        send_text(&mut socket, &notification).await;
    }
    for unreadable in ["not a message", "[1, 2]", "{}"] {
        socket
            .send(Message::text(unreadable))
            .await
            .expect("the client writes");
        let refused = next_text(&mut socket).await;
        assert_eq!(refused["id"], -1, "{unreadable}");
        assert_eq!(refused["error"]["code"], -32600, "{unreadable}");
    }
    let mistyped = json!({ "id": 9, "method": "http/request", "params": {
        "requestId": "http-1", "streamResponse": null,
    }});
    send_text(&mut socket, &mistyped).await;
    let refused = next_text(&mut socket).await;
    assert_eq!(
        refused["id"], 9,
        "a request whose params do not read keeps its id"
    );
    assert_eq!(refused["error"]["code"], -32602);
    let served = json!({ "id": 3, "method": "environment/info", "params": null });
    send_text(&mut socket, &served).await;
    let forwarded = next_forwarded(&mut fake).await;
    assert_eq!(forwarded["method"], "environment/info");
    assert_quiet(&mut socket).await;
}

// The executor's ask `id` about `process`'s network access.
fn policy_request(id: u64, process: &Value) -> Value {
    json!({
        "id": id,
        "method": "network/policyRequest",
        "params": {
            "processId": process,
            "request": { "protocol": "https_connect", "host": "example.com", "port": 443 },
        },
    })
}

// The relay's deny of the ask `id`.
fn denied(id: u64) -> Value {
    json!({ "id": id, "result": { "decision": { "type": "deny", "reason": "not_allowed" } } })
}

// Starts `OWN_PROCESS` on `socket`, answers the start as the executor does, and returns the relay
// id the executor read it under.
async fn start_own_process(socket: &mut ClientSocket, fake: &mut FakeExecutor) -> Value {
    let start = json!({ "id": 2, "method": "process/start", "params": {
        "processId": OWN_PROCESS,
        "argv": ["/usr/bin/codex-mcp"],
        "cwd": "file:///tmp",
        "env": {},
        "tty": false,
        "arg0": null,
    }});
    send_text(socket, &start).await;
    let started = next_forwarded(fake).await;
    let relay_process = started["params"]["processId"].clone();
    fake.write(&json!({
        "id": started["id"],
        "result": { "processId": relay_process, "sandboxType": "none" },
    }))
    .await;
    assert_eq!(
        next_text(socket).await,
        json!({ "id": 2, "result": { "processId": OWN_PROCESS, "sandboxType": "none" } })
    );
    relay_process
}

// A `process/read` of `process` under `id`.
fn read(id: u64, process: &str) -> Value {
    json!({ "id": id, "method": "process/read", "params": { "processId": process, "afterSeq": 0 } })
}

// A `process/output` of `process` carrying `chunk`.
fn output(process: &Value, chunk: &str) -> Value {
    json!({
        "method": "process/output",
        "params": { "processId": process, "seq": 1, "stream": "stdout", "chunk": chunk },
    })
}
