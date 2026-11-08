//! The exchange through the relay: messages pass, the client's handshake is answered from the
//! relay's own, a start is rewritten and recorded, and only the start's token is admitted.

use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
use tokio_tungstenite::tungstenite::http::{HeaderValue, header};

use super::{
    CALL, EXECUTOR_PROCESS, ListeningRelay, THREAD, admitted_socket, command_id, listening_relay,
    next_text, send_text,
};
use crate::driver::codex::exec_relay::RelayedCommand;
use crate::driver::test_registry::new_session_id;

// Everything the service and the executor say passes unchanged, but the client's `initialize`,
// answered from the relay's own, each request's id and each process's id, which reach the executor
// as relay ids and come back as the client's, and a start, whose environment gains the no-prompt
// variables where no wrapper runs it and whose command is recorded under its call until the
// executor reports it ended. A connection without the start's token is refused.
#[tokio::test]
async fn passes_an_exchange_and_admits_only_the_token() {
    let folder = tempfile::tempdir().expect("a test folder");
    let session_id = new_session_id();
    let ListeningRelay {
        relay,
        mut fake,
        url,
        presented,
    } = listening_relay(session_id, folder.path()).await;

    for authorization in [None, Some("Bearer not-the-token")] {
        let mut request = url.as_str().into_client_request().expect("a request");
        if let Some(authorization) = authorization {
            request.headers_mut().insert(
                header::AUTHORIZATION,
                HeaderValue::from_static(authorization),
            );
        }
        assert!(
            tokio_tungstenite::connect_async(request).await.is_err(),
            "{authorization:?} is refused"
        );
    }
    let mut socket = admitted_socket(&url, &presented).await;

    send_text(
        &mut socket,
        &json!({ "id": 1, "method": "initialize", "params": { "clientName": "codex" } }),
    )
    .await;
    assert_eq!(
        next_text(&mut socket).await,
        json!({ "id": 1, "result": { "sessionId": "executor-1" } })
    );
    send_text(&mut socket, &json!({ "method": "initialized" })).await;

    let start = json!({ "id": 2, "method": "process/start", "params": {
        "processId": EXECUTOR_PROCESS,
        "argv": ["/bin/sh", "-lc", "echo hi"],
        "cwd": "file:///tmp",
        "env": { "KEPT": "1" },
        "tty": false,
        "arg0": null,
        "metadata": { "threadId": THREAD, "toolCallId": CALL },
    }});
    send_text(&mut socket, &start).await;
    let started = fake.next_sent().await;
    let relay_id = started["id"].clone();
    let relay_process = started["params"]["processId"].clone();
    assert!(
        relay_process
            .as_str()
            .is_some_and(|process| process.starts_with("sidekicks-process-")),
        "no initialize reaches the executor, and the start runs under the relay's id: {started}"
    );
    let mut started = with_client_id(started, &start);
    let environment = started["params"]["env"]
        .as_object_mut()
        .expect("the start carries its environment")
        .clone();
    assert_eq!(environment["KEPT"], "1");
    assert_eq!(environment["GIT_TERMINAL_PROMPT"], "0");
    started["params"]["env"] = start["params"]["env"].clone();
    started["params"]["processId"] = start["params"]["processId"].clone();
    assert_eq!(
        started, start,
        "only the environment and the process id change where no channel is open"
    );
    fake.write(&json!({ "id": relay_id, "result": { "processId": relay_process } }))
        .await;
    assert_eq!(
        next_text(&mut socket).await,
        json!({ "id": 2, "result": { "processId": EXECUTOR_PROCESS } })
    );
    assert_eq!(
        relay.relayed_command(session_id, &command_id()),
        Some(RelayedCommand {
            session_id,
            thread_id: THREAD.to_owned(),
            executor_process_id: relay_process.as_str().expect("a relay id").to_owned(),
            terminal_process_id: "7".to_owned(),
            accepts_input: false,
            service_start: 0,
        })
    );

    let read = json!({ "id": 3, "method": "process/read", "params": {
        "processId": EXECUTOR_PROCESS,
        "afterSeq": 0,
    }});
    send_text(&mut socket, &read).await;
    let mut forwarded = with_client_id(fake.next_sent().await, &read);
    assert_eq!(forwarded["params"]["processId"], relay_process);
    forwarded["params"]["processId"] = read["params"]["processId"].clone();
    assert_eq!(forwarded, read);
    let output = |process: &Value| {
        json!({
            "method": "process/output",
            "params": { "processId": process, "seq": 1, "chunk": "aGk=" },
        })
    };
    fake.write(&output(&relay_process)).await;
    assert_eq!(
        next_text(&mut socket).await,
        output(&json!(EXECUTOR_PROCESS))
    );

    let terminate = json!({
        "id": 4,
        "method": "process/terminate",
        "params": { "processId": EXECUTOR_PROCESS },
    });
    send_text(&mut socket, &terminate).await;
    assert_eq!(
        with_client_id(fake.next_sent().await, &terminate)["params"]["processId"],
        relay_process
    );
    let exited = |process: &Value| {
        json!({
            "method": "process/exited",
            "params": { "processId": process, "seq": 2, "exitCode": 0 },
        })
    };
    fake.write(&exited(&relay_process)).await;
    assert_eq!(
        next_text(&mut socket).await,
        exited(&json!(EXECUTOR_PROCESS))
    );
    for _turn in 0..100 {
        if relay.relayed_command(session_id, &command_id()).is_none() {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("the ended command is still recorded");
}

// `forwarded`, a request the executor read, with `sent`'s id in place of its relay id, failing
// when it reached the executor under no relay id.
fn with_client_id(mut forwarded: Value, sent: &Value) -> Value {
    assert!(
        forwarded["id"]
            .as_str()
            .is_some_and(|id| id.starts_with("sidekicks-client-")),
        "the request reached the executor under {}",
        forwarded["id"]
    );
    forwarded["id"] = sent["id"].clone();
    forwarded
}
