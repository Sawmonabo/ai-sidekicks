//! The exchange through the relay: messages pass, the client's handshake is answered from the
//! relay's own, a start is rewritten and recorded, and only the start's token is admitted.

use std::sync::Arc;

use futures::SinkExt as _;
use serde_json::{Value, json};
use sidekicks_std::mutex_lock::lock;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
use tokio_tungstenite::tungstenite::http::{HeaderValue, header};

use super::{EXECUTOR_PROCESS, THREAD, command_id, initialized_executor, next_text, relay_for};
use crate::bearer_token::BearerToken;
use crate::driver::codex::exec_relay::RelayedCommand;
use crate::driver::codex::exec_relay::endpoint::RelayEndpoint;
use crate::driver::test_registry::new_session_id;

// Everything the service and the executor say passes unchanged, but the client's `initialize`,
// answered from the relay's own, and a start, whose environment gains the no-prompt variables
// where no wrapper runs it and whose command is recorded under its call until the executor
// reports it ended. A connection without the start's token is refused.
#[tokio::test]
async fn passes_an_exchange_and_admits_only_the_token() {
    let folder = tempfile::tempdir().expect("a test folder");
    let session_id = new_session_id();
    let relay = relay_for(session_id, folder.path());
    let (executor, mut fake) = initialized_executor().await;
    relay.take_executor(executor);
    let token = BearerToken::mint().expect("a token mints");
    let presented = format!("Bearer {}", token.text());
    let endpoint = RelayEndpoint::listen(Arc::downgrade(&relay), token)
        .await
        .expect("the relay listens");
    let url = endpoint.url();
    *lock(&relay.endpoint) = Some(endpoint);

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
    let mut request = url.as_str().into_client_request().expect("a request");
    request.headers_mut().insert(
        header::AUTHORIZATION,
        HeaderValue::from_str(&presented).expect("a header value"),
    );
    let (mut socket, _response) = tokio_tungstenite::connect_async(request)
        .await
        .expect("the token is admitted");

    let send = |message: Value| Message::text(message.to_string());
    socket
        .send(send(
            json!({ "id": 1, "method": "initialize", "params": { "clientName": "codex" } }),
        ))
        .await
        .expect("the client writes");
    assert_eq!(
        next_text(&mut socket).await,
        json!({ "id": 1, "result": { "sessionId": "executor-1" } })
    );
    socket
        .send(send(json!({ "method": "initialized" })))
        .await
        .expect("the client writes");
    let read =
        json!({ "id": 2, "method": "process/read", "params": { "processId": "p", "afterSeq": 0 } });
    socket
        .send(send(read.clone()))
        .await
        .expect("the client writes");
    assert_eq!(
        fake.next_sent().await,
        read,
        "no initialize reaches the executor"
    );
    let output = json!({
        "method": "process/output",
        "params": { "processId": "p", "seq": 1, "chunk": "aGk=" },
    });
    fake.write(&output).await;
    assert_eq!(next_text(&mut socket).await, output);

    let start = json!({ "id": 3, "method": "process/start", "params": {
        "processId": EXECUTOR_PROCESS,
        "argv": ["/bin/sh", "-lc", "echo hi"],
        "cwd": "file:///tmp",
        "env": { "KEPT": "1" },
        "tty": false,
        "arg0": null,
        "metadata": { "threadId": THREAD, "toolCallId": CALL },
    }});
    socket
        .send(send(start.clone()))
        .await
        .expect("the client writes");
    let mut started = fake.next_sent().await;
    let environment = started["params"]["env"]
        .as_object_mut()
        .expect("the start carries its environment")
        .clone();
    assert_eq!(environment["KEPT"], "1");
    assert_eq!(environment["GIT_TERMINAL_PROMPT"], "0");
    started["params"]["env"] = start["params"]["env"].clone();
    assert_eq!(
        started, start,
        "only the environment changes where no channel is open"
    );
    let answer = json!({ "id": 3, "result": {} });
    fake.write(&answer).await;
    assert_eq!(next_text(&mut socket).await, answer);
    assert_eq!(
        relay.relayed_command(session_id, &command_id()),
        Some(RelayedCommand {
            session_id,
            thread_id: THREAD.to_owned(),
            executor_process_id: EXECUTOR_PROCESS.to_owned(),
            terminal_process_id: "7".to_owned(),
            accepts_input: false,
            service_start: 0,
        })
    );

    let terminate = json!({
        "id": 4,
        "method": "process/terminate",
        "params": { "processId": EXECUTOR_PROCESS },
    });
    socket
        .send(send(terminate.clone()))
        .await
        .expect("the client writes");
    assert_eq!(fake.next_sent().await, terminate);
    let exited = json!({
        "method": "process/exited",
        "params": { "processId": EXECUTOR_PROCESS, "seq": 2, "exitCode": 0 },
    });
    fake.write(&exited).await;
    assert_eq!(next_text(&mut socket).await, exited);
    for _turn in 0..100 {
        if relay.relayed_command(session_id, &command_id()).is_none() {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("the ended command is still recorded");
}
