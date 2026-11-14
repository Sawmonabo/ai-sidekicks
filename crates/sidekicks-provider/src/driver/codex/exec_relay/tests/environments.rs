//! Each environment admitted by its own token, and a dropped connection's processes held for its
//! resume by that environment until its window passes or the environment opens afresh.

use std::sync::Arc;
use std::time::Duration;

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_std::mutex_lock::lock;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
use tokio_tungstenite::tungstenite::http::{HeaderValue, header};
use tokio_util::sync::CancellationToken;

use super::processes::{OWN_PROCESS, output, read, start_own_process};
use super::{
    CALL, ClientSocket, EXECUTOR_PROCESS, FakeExecutor, ListeningRelay, THREAD,
    admitted_environment, admitted_socket, assert_executor_quiet, command_id, initialize,
    initialized_executor, listening_relay, next_forwarded, next_line, next_text, relay_for,
    send_text,
};
use crate::bounded_poll::poll_until;
use crate::driver::codex::exec_relay::executor::{
    CodexExecutor, DETACHED_CONNECTION_HOLD, RelayConnectionId,
};
use crate::driver::codex::exec_relay::{CODEX_RELAY_ENVIRONMENT_ID, CodexExecRelay};
use crate::driver::test_registry::new_session_id;

// The environment of a side question's copy, admitted beside the service's own.
const COPY_ENVIRONMENT: &str = "sidekicks-copy";

// A connection with no token or a wrong one is refused, and each environment's token admits that
// environment alone: a session the service's connection opened is not resumed through the copy's
// token, and is through the service's. A start retires both tokens and admits the service's own
// under a new one. Killed by admitting a connection under any environment (the copy's resume
// succeeds), by a token left from before the start (a retired token is admitted) and by a start
// that admits no token (the new one is refused).
#[tokio::test]
async fn each_environment_is_admitted_by_its_own_token() {
    let folder = tempfile::tempdir().expect("a test folder");
    // The executor's far side is kept to the end, so the executor runs.
    let ListeningRelay {
        relay,
        fake: _fake,
        url,
        presented,
    } = listening_relay(new_session_id(), folder.path()).await;
    let (_url, copy_presented) = admitted_environment(&relay, COPY_ENVIRONMENT);
    for refused in [None, Some("Bearer not-a-token")] {
        assert!(!is_admitted(&url, refused).await, "{refused:?} is refused");
    }

    let mut service = admitted_socket(&url, &presented).await;
    let session_id = initialize(&mut service).await;
    service.close(None).await.expect("the client closes");
    poll_until(|| connection_count(&relay), |open| *open == 0).await;
    let mut copy = admitted_socket(&url, &copy_presented).await;
    assert_eq!(
        resume(&mut copy, &session_id).await["error"]["code"],
        -32600
    );
    let mut service = admitted_socket(&url, &presented).await;
    assert_eq!(
        resume(&mut service, &session_id).await["result"]["sessionId"],
        session_id
    );

    let added = relay
        .start(tokio::process::Command::new("false"))
        .await
        .expect("the relay readies its running executor's next start");
    for retired in [&presented, &copy_presented] {
        assert!(
            !is_admitted(&url, Some(retired.as_str())).await,
            "a retired token is refused"
        );
    }
    let token = added
        .auth_bearer_token
        .expect("the start carries its token");
    let presented = format!("Bearer {token}");
    assert!(is_admitted(&url, Some(presented.as_str())).await);
}

// A connection that started a process drops; another connection of its environment resumes its
// session, is answered under that session, and reads the process under its own id, which reaches
// the executor under the same relay id with nothing ended meanwhile. Killed by forgetting a
// dropped connection's ids at once (the read reaches the executor as an unknown process) and by
// ending its processes at the drop (a terminate is the next line the executor reads).
#[tokio::test]
async fn a_dropped_connections_processes_wait_for_its_resume() {
    let folder = tempfile::tempdir().expect("a test folder");
    let ListeningRelay {
        relay,
        mut fake,
        url,
        presented,
    } = listening_relay(new_session_id(), folder.path()).await;
    let mut dropped = admitted_socket(&url, &presented).await;
    let session_id = initialize(&mut dropped).await;
    let relay_process = start_own_process(&mut dropped, &mut fake).await;
    dropped.close(None).await.expect("the client closes");
    poll_until(|| connection_count(&relay), |open| *open == 0).await;

    let mut resumed = admitted_socket(&url, &presented).await;
    assert_eq!(
        resume(&mut resumed, &session_id).await,
        json!({ "id": 1, "result": { "sessionId": session_id } })
    );
    send_text(&mut resumed, &read(3, OWN_PROCESS)).await;
    let forwarded = next_forwarded(&mut fake).await;
    assert_eq!(forwarded["method"], "process/read");
    assert_eq!(forwarded["params"]["processId"], relay_process);
    fake.write(&output(&relay_process, "YmFjaw==")).await;
    assert_eq!(
        next_text(&mut resumed).await,
        output(&json!(OWN_PROCESS), "YmFjaw==")
    );
}

// A resume of a session whose connection is still open is refused `-32010`, which Codex's client
// retries, and of a session no connection opened `-32600`; a second `initialize` on a connection
// that opened one is refused `-32600`. Killed by a resume that takes an attached session (the
// first answer is a result) and by a resume of any id (the second is).
#[tokio::test]
async fn a_resume_is_refused_while_attached_and_for_an_unknown_session() {
    let folder = tempfile::tempdir().expect("a test folder");
    let ListeningRelay {
        relay: _relay,
        fake: _fake,
        url,
        presented,
    } = listening_relay(new_session_id(), folder.path()).await;
    let mut attached = admitted_socket(&url, &presented).await;
    let session_id = initialize(&mut attached).await;
    let mut other = admitted_socket(&url, &presented).await;

    assert_eq!(
        resume(&mut other, &session_id).await["error"]["code"],
        -32010
    );
    assert_eq!(
        resume(&mut other, "no-such-session").await["error"]["code"],
        -32600
    );
    assert_eq!(
        resume(&mut attached, &session_id).await["error"]["code"],
        -32600
    );
}

// How a dropped connection's hold ends.
#[derive(Clone, Copy, Debug)]
enum HoldEnd {
    // Its window passes.
    Window,
    // Its environment opens afresh.
    FreshStart,
}

// A dropped connection that started a tool server's process and a call's command: nothing is
// ended before the hold ends; at its end, by its window or by a fresh `initialize` from its
// environment, the tool server's process alone is terminated and the command runs on, still
// recorded. Killed by ending every held process (the command's terminate breaks the quiet) and by
// a hold that never ends (no terminate comes).
#[rstest]
#[case::at_its_window(HoldEnd::Window)]
#[case::at_a_fresh_start(HoldEnd::FreshStart)]
#[tokio::test(start_paused = true)]
async fn a_hold_ends_all_but_its_commands_at_its_window_or_a_fresh_start(#[case] end: HoldEnd) {
    let folder = tempfile::tempdir().expect("a test folder");
    let session_id = new_session_id();
    let relay = relay_for(session_id, folder.path());
    let (executor, mut fake) = initialized_executor().await;
    relay.take_executor(Arc::clone(&executor));
    let (client, mut received) = mpsc::channel(16);
    let (executor, connection) = attach(&relay, client);
    open_session(&relay, &executor, connection, &mut received).await;
    let tool_process = start_answered(
        &relay,
        (&executor, connection),
        (&mut fake, &mut received),
        json!({ "id": 2, "method": "process/start", "params": start_params(OWN_PROCESS) }),
    )
    .await;
    let mut command_start = start_params(EXECUTOR_PROCESS);
    command_start["metadata"] = json!({ "threadId": THREAD, "toolCallId": CALL });
    start_answered(
        &relay,
        (&executor, connection),
        (&mut fake, &mut received),
        json!({ "id": 3, "method": "process/start", "params": command_start }),
    )
    .await;

    relay.let_go(&executor, connection).await;
    assert_executor_quiet(&mut fake).await;
    match end {
        HoldEnd::Window => {
            let before_window = DETACHED_CONNECTION_HOLD
                .checked_sub(Duration::from_secs(1))
                .expect("the hold is longer than a second");
            tokio::time::sleep(before_window).await;
            assert_executor_quiet(&mut fake).await;
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        HoldEnd::FreshStart => {
            let (client, mut received) = mpsc::channel(16);
            let (executor, connection) = attach(&relay, client);
            open_session(&relay, &executor, connection, &mut received).await;
        }
    }

    let terminated = next_forwarded(&mut fake).await;
    assert_eq!(terminated["method"], "process/terminate");
    assert_eq!(terminated["params"]["processId"], tool_process);
    assert_executor_quiet(&mut fake).await;
    assert!(
        relay.relayed_command(session_id, &command_id()).is_some(),
        "the command runs on"
    );
}

// Whether a connection to `url` presenting `authorization` is admitted.
async fn is_admitted(url: &str, authorization: Option<&str>) -> bool {
    let mut request = url.into_client_request().expect("a request");
    if let Some(authorization) = authorization {
        request.headers_mut().insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(authorization).expect("a header value"),
        );
    }
    tokio_tungstenite::connect_async(request).await.is_ok()
}

// How many connections `relay`'s executor has attached.
fn connection_count(relay: &CodexExecRelay) -> usize {
    lock(&relay.executor)
        .as_ref()
        .map_or(0, |executor| executor.connection_count())
}

// Sends `initialize` under id 1 resuming `session_id` on `socket` and reads its answer.
async fn resume(socket: &mut ClientSocket, session_id: &str) -> Value {
    send_text(
        socket,
        &json!({ "id": 1, "method": "initialize", "params": {
            "clientName": "codex",
            "resumeSessionId": session_id,
        }}),
    )
    .await;
    next_text(socket).await
}

// `client` attached onto `relay`'s executor as a connection of the service's own environment.
fn attach(
    relay: &CodexExecRelay,
    client: mpsc::Sender<String>,
) -> (Arc<CodexExecutor>, RelayConnectionId) {
    relay
        .attach_client(
            client,
            CancellationToken::new(),
            CODEX_RELAY_ENVIRONMENT_ID.into(),
        )
        .expect("an executor runs")
}

// Opens a session of `connection`'s own with a fresh `initialize`, reading its answer.
async fn open_session(
    relay: &CodexExecRelay,
    executor: &Arc<CodexExecutor>,
    connection: RelayConnectionId,
    received: &mut mpsc::Receiver<String>,
) {
    let initialize =
        json!({ "id": 1, "method": "initialize", "params": { "clientName": "codex" } });
    relay
        .take_client_message(executor, connection, initialize.to_string())
        .await;
    assert!(next_line(received).await["result"]["sessionId"].is_string());
}

// A process start's params under the connection's own `process` id.
fn start_params(process: &str) -> Value {
    json!({
        "processId": process,
        "argv": ["/bin/sleep", "60"],
        "cwd": "file:///tmp",
        "env": {},
        "tty": false,
        "arg0": null,
    })
}

// Sends `start` from the connection, answers it as the executor does and reads the answer the
// connection gets, returning the relay id the executor ran the process under.
async fn start_answered(
    relay: &CodexExecRelay,
    (executor, connection): (&Arc<CodexExecutor>, RelayConnectionId),
    (fake, received): (&mut FakeExecutor, &mut mpsc::Receiver<String>),
    start: Value,
) -> Value {
    relay
        .take_client_message(executor, connection, start.to_string())
        .await;
    let sent = next_forwarded(fake).await;
    let relay_process = sent["params"]["processId"].clone();
    fake.write(&json!({ "id": sent["id"], "result": { "processId": relay_process } }))
        .await;
    assert_eq!(next_line(received).await["id"], start["id"]);
    relay_process
}
