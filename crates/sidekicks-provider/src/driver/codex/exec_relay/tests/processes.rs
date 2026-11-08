//! Each connection's processes on the relay's one executor: run under the relay's own ids, every
//! message about one reaching only the connection that started it.

use serde_json::{Value, json};

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
// to the second, and the first reads nothing. Killed by passing an id the connection never started
// on as it came, which reaches the first's process.
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
    assert_quiet(&mut owner).await;
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
