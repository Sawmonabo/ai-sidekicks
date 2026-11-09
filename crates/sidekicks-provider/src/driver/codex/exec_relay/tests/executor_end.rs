use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::{initialized_executor, next_line, relay_for};
use crate::driver::codex::exec_relay::executor_end::EXECUTOR_ENDED_MESSAGE;
use crate::driver::test_registry::new_session_id;

// Once the executor ends, a command running on it is reported ended under the connection's own
// process id after the last event the connection got of it, the read waiting on the executor and a
// start sent after it are answered under their own ids with the error naming the end, and the
// connection stays open. Killed by numbering the end from the command's start rather than its last
// event, by reporting no end, by leaving the read unanswered and by passing the later start on to
// the ended executor, each failing a wait or an assertion.
#[tokio::test]
async fn an_ended_executor_s_commands_end_and_its_requests_are_answered() {
    let folder = tempfile::tempdir().expect("a test folder");
    let relay = relay_for(new_session_id(), folder.path());
    let (executor, mut fake) = initialized_executor().await;
    relay.take_executor(Arc::clone(&executor));
    let (client, mut received) = mpsc::channel(16);
    let (executor, connection) = relay
        .attach_client(client, CancellationToken::new())
        .expect("an executor runs");

    let start = json!({ "id": 1, "method": "process/start", "params": {
        "processId": "running",
        "argv": ["/bin/sleep", "60"],
        "cwd": "file:///tmp",
        "env": {},
        "tty": false,
        "arg0": null,
    }});
    relay
        .take_client_message(&executor, connection, start.to_string())
        .await;
    let sent = fake.next_sent().await;
    assert_eq!(sent["method"], "process/start");
    let relay_process = sent["params"]["processId"].clone();
    fake.write(&json!({ "id": sent["id"], "result": { "processId": relay_process } }))
        .await;
    assert_eq!(next_line(&mut received).await["id"], 1);
    let output = |process: &Value| {
        json!({ "method": "process/output", "params": {
            "processId": process, "seq": 1, "stream": "stdout", "chunk": "aGk=",
        }})
    };
    fake.write(&output(&relay_process)).await;
    assert_eq!(next_line(&mut received).await, output(&json!("running")));
    let read = json!({ "id": 2, "method": "process/read", "params": {
        "processId": "running", "afterSeq": 1, "waitMs": 30_000,
    }});
    relay
        .take_client_message(&executor, connection, read.to_string())
        .await;
    let sent = fake.next_sent().await;
    assert_eq!(sent["method"], "process/read");
    assert_eq!(sent["params"]["processId"], relay_process);

    drop(fake);

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
        .take_client_message(&executor, connection, later.to_string())
        .await;
    assert_eq!(next_line(&mut received).await, ended_answer(3));
}

// Once the executor ends, a streamed http body the connection reads gets a last delta numbered
// after the last it got, carrying the error that names the end, the connection's kept missing
// watch is told it changed, and a later watch is answered with the end's error. Killed by clearing
// the bodies or the watches at the end with nothing sent, by numbering the last delta from 1, and
// by answering the later watch as not watching, each failing an assertion or a wait.
#[tokio::test]
async fn an_ended_executor_ends_each_streamed_body_and_fires_each_kept_watch() {
    let folder = tempfile::tempdir().expect("a test folder");
    let relay = relay_for(new_session_id(), folder.path());
    let (executor, mut fake) = initialized_executor().await;
    relay.take_executor(Arc::clone(&executor));
    let (client, mut received) = mpsc::channel(16);
    let (executor, connection) = relay
        .attach_client(client, CancellationToken::new())
        .expect("an executor runs");

    let streamed = json!({ "id": 4, "method": "http/request", "params": {
        "method": "GET",
        "url": "https://example.com/events",
        "headers": [],
        "requestId": "http-1",
        "streamResponse": true,
    }});
    relay
        .take_client_message(&executor, connection, streamed.to_string())
        .await;
    let sent = fake.next_sent().await;
    assert_eq!(sent["method"], "http/request");
    let relay_request = sent["params"]["requestId"].clone();
    let headers = json!({ "status": 200, "headers": [], "bodyBase64": "" });
    fake.write(&json!({ "id": sent["id"], "result": headers }))
        .await;
    assert_eq!(
        next_line(&mut received).await,
        json!({ "id": 4, "result": headers })
    );
    let delta = |request: &Value| {
        json!({ "method": "http/request/bodyDelta", "params": {
            "requestId": request, "seq": 1, "deltaBase64": "aGk=", "done": false,
        }})
    };
    fake.write(&delta(&relay_request)).await;
    assert_eq!(next_line(&mut received).await, delta(&json!("http-1")));

    relay
        .take_client_message(&executor, connection, watch_missing(5).to_string())
        .await;
    let union = fake.next_sent().await;
    assert_eq!(union["method"], "fs/watchMissing");
    fake.write(&json!({ "id": union["id"], "result": { "watching": true } }))
        .await;
    assert_eq!(
        next_line(&mut received).await,
        json!({ "id": 5, "result": { "watching": true } })
    );

    drop(fake);

    assert_eq!(
        next_line(&mut received).await,
        json!({ "method": "http/request/bodyDelta", "params": {
            "requestId": "http-1",
            "seq": 2,
            "deltaBase64": "",
            "done": true,
            "error": EXECUTOR_ENDED_MESSAGE,
        }})
    );
    assert_eq!(
        next_line(&mut received).await,
        json!({ "method": "fs/missingChanged", "params": { "watchId": 7 } })
    );
    relay
        .take_client_message(&executor, connection, watch_missing(6).to_string())
        .await;
    assert_eq!(next_line(&mut received).await, ended_answer(6));
}

// The answer to the request `id` once the executor ended.
fn ended_answer(id: u64) -> Value {
    json!({ "id": id, "error": { "code": -32603, "message": EXECUTOR_ENDED_MESSAGE } })
}

// A client's watch of one missing path under request id `id` and its own watch id 7.
fn watch_missing(id: u64) -> Value {
    json!({ "id": id, "method": "fs/watchMissing", "params": {
        "watchId": 7,
        "missing": ["/tmp/sidekicks-missing"],
        "present": null,
    }})
}
