use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::{initialized_executor, relay_for};
use crate::driver::test_registry::new_session_id;

/// How long the client waits for each line the relay owes it.
const LINE_WAIT: Duration = Duration::from_secs(5);

// The next line the relay handed its client, failing after a bound.
async fn next_line(client: &mut mpsc::Receiver<String>) -> Value {
    let line = tokio::time::timeout(LINE_WAIT, client.recv())
        .await
        .expect("the relay answers its client in time")
        .expect("the client is still attached");
    serde_json::from_str(&line).expect("the relay writes JSON")
}

// Once the executor ends, a command running on it is reported ended after the last event the client
// got of it, the read waiting on the executor and a start sent after it are answered with the
// error naming the end, and the connection stays open. Killed by numbering the end from the
// command's start rather than its last event, by reporting no end, by leaving the read unanswered
// and by passing the later start on to the ended executor, each failing a wait or an assertion.
#[tokio::test]
async fn an_ended_executor_s_commands_end_and_its_requests_are_answered() {
    let folder = tempfile::tempdir().expect("a test folder");
    let relay = relay_for(new_session_id(), folder.path());
    let (executor, mut fake) = initialized_executor().await;
    relay.take_executor(Arc::clone(&executor));
    let (client, mut received) = mpsc::channel(16);
    let executor = relay.attach_client(client).expect("an executor runs");

    let start = json!({ "id": 1, "method": "process/start", "params": {
        "processId": "running",
        "argv": ["/bin/sleep", "60"],
        "cwd": "file:///tmp",
        "env": {},
        "tty": false,
        "arg0": null,
    }});
    relay
        .take_client_message(&executor, start.to_string())
        .await;
    assert_eq!(fake.next_sent().await["method"], "process/start");
    fake.write(&json!({ "id": 1, "result": { "processId": "running" } }))
        .await;
    assert_eq!(next_line(&mut received).await["id"], 1);
    let output = json!({ "method": "process/output", "params": {
        "processId": "running", "seq": 1, "stream": "stdout", "chunk": "aGk=",
    }});
    fake.write(&output).await;
    assert_eq!(next_line(&mut received).await, output);
    let read = json!({ "id": 2, "method": "process/read", "params": {
        "processId": "running", "afterSeq": 1, "waitMs": 30_000,
    }});
    relay.take_client_message(&executor, read.to_string()).await;
    assert_eq!(fake.next_sent().await, read);

    drop(fake);

    let ended_answer = |id: u64| {
        json!({ "id": id, "error": {
            "code": -32603,
            "message": "The Codex executor running this service's commands ended; the service \
                        starts a new one.",
        }})
    };
    assert_eq!(next_line(&mut received).await, ended_answer(2));
    let ended_output = next_line(&mut received).await;
    assert_eq!(ended_output["method"], "process/output");
    assert_eq!(ended_output["params"]["seq"], 2);
    assert_eq!(ended_output["params"]["stream"], "stderr");
    let chunk = STANDARD
        .decode(
            ended_output["params"]["chunk"]
                .as_str()
                .expect("a chunk is text"),
        )
        .expect("a chunk is base64");
    assert!(
        String::from_utf8_lossy(&chunk).contains("executor running this service's commands ended"),
        "the command's last output names the end"
    );
    assert_eq!(
        next_line(&mut received).await,
        json!({ "method": "process/exited", "params": {
            "processId": "running", "seq": 3, "exitCode": -1, "sandboxDenied": false,
        }})
    );
    assert_eq!(
        next_line(&mut received).await,
        json!({ "method": "process/closed", "params": { "processId": "running", "seq": 4 } })
    );

    let later = json!({ "id": 3, "method": "process/start", "params": {
        "processId": "later",
        "argv": ["/bin/true"],
        "cwd": "file:///tmp",
        "env": {},
        "tty": false,
        "arg0": null,
    }});
    relay
        .take_client_message(&executor, later.to_string())
        .await;
    assert_eq!(next_line(&mut received).await, ended_answer(3));
}
