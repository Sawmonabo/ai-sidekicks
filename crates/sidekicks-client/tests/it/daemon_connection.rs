//! Opening a daemon connection over a real local socket: the token is read at each connect and
//! once more when the daemon refuses it, a run folder that is not this account's alone is refused
//! before the client writes a byte, and a lost link is opened again on the client's schedule, each
//! attempt held to the handshake deadline, until the connection is down and only a retry reopens
//! it.

use std::path::Path;
use std::time::Duration;

use futures::FutureExt as _;
use interprocess::local_socket::tokio::{Listener, Stream};
use interprocess::local_socket::traits::tokio::Listener as _;
use interprocess::local_socket::{GenericFilePath, ListenerOptions, ToFsName as _};
use serde_json::json;
use sidekicks_client::daemon_connection::{
    ConnectionState, DaemonConnection, DaemonEndpoint, HANDSHAKE_DEADLINE, LINK_REOPEN_BACKOFF_MS,
};
use sidekicks_client::error::ClientError;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::method::Method;
use sidekicks_contracts::session::methods::SessionRead;
use sidekicks_platforms::DaemonRunFolder;
use tokio::io::AsyncReadExt as _;
use tokio::sync::watch;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::helpers::{ScriptedDaemon, raw_request};

/// How long a test waits for the client before it counts as stuck.
const PATIENCE: Duration = Duration::from_secs(10);

fn run_folder(folder_path: &Path, socket_folder: &Path) -> DaemonRunFolder {
    DaemonRunFolder {
        folder_path: folder_path.to_path_buf(),
        socket_path: socket_folder.join("daemon.sock"),
        token_path: socket_folder.join("token"),
    }
}

fn listen(run_folder: &DaemonRunFolder) -> Listener {
    let name = run_folder
        .socket_path
        .as_path()
        .to_fs_name::<GenericFilePath>()
        .expect("a socket path in a temporary folder");
    ListenerOptions::new()
        .name(name)
        .create_tokio()
        .expect("the test binds its socket")
}

async fn accept(listener: &Listener) -> ScriptedDaemon<Stream> {
    let stream = tokio::time::timeout(PATIENCE, listener.accept())
        .await
        .expect("the client connects")
        .expect("the connection is accepted");
    ScriptedDaemon::new(stream)
}

/// Longer than the whole reconnect schedule with a handshake deadline, on the paused clock.
const SCHEDULE_PATIENCE: Duration = Duration::from_secs(120);

/// The slack a paused clock's millisecond timer ticks add to a wait.
const TICK_SLACK: Duration = Duration::from_millis(20);

/// Accepts the client's next attempt on the reconnect schedule and answers when it came.
async fn accept_attempt(listener: &Listener) -> (ScriptedDaemon<Stream>, Instant) {
    let stream = tokio::time::timeout(SCHEDULE_PATIENCE, listener.accept())
        .await
        .expect("the client tries again")
        .expect("the connection is accepted");
    (ScriptedDaemon::new(stream), Instant::now())
}

/// Asserts that `elapsed` is `expected`, give or take the timer's ticks.
fn assert_waited(elapsed: Duration, expected: Duration) {
    assert!(
        elapsed >= expected && elapsed < expected + TICK_SLACK,
        "waited {elapsed:?}, not {expected:?}"
    );
}

async fn wait_for_state(states: &mut watch::Receiver<ConnectionState>, state: ConnectionState) {
    tokio::time::timeout(SCHEDULE_PATIENCE, states.wait_for(|now| *now == state))
        .await
        .expect("the connection reaches the state")
        .expect("the supervisor runs");
}

/// Reads `connection.initialize`, checks the token it presents and answers its id.
async fn read_initialize(daemon: &mut ScriptedDaemon<Stream>, token: &str) -> serde_json::Value {
    let request = daemon.next_message().await;
    assert_eq!(request["params"]["sessionToken"], token);
    request["id"].clone()
}

#[tokio::test]
async fn a_refused_token_is_read_again_and_retried_once_only_when_the_file_changed() {
    let folder = tempfile::tempdir().expect("a temporary folder");
    let private = folder.path().join("run");
    sidekicks_platforms::create_private_folder(&private).expect("the run folder is made private");
    let run_folder = run_folder(&private, &private);
    let listener = listen(&run_folder);
    std::fs::write(&run_folder.token_path, "first-token").expect("the token is written");

    let connecting = tokio::spawn(DaemonConnection::connect(DaemonEndpoint::new(
        run_folder.clone(),
    )));
    let mut first = accept(&listener).await;
    let id = read_initialize(&mut first, "first-token").await;
    // The daemon restarted and wrote a new token after the client read the old one.
    std::fs::write(&run_folder.token_path, "second-token").expect("the token is rewritten");
    first.refuse(&id, RefusalCode::AuthTokenInvalid).await;
    let mut second = accept(&listener).await;
    second.answer_initialize_with_token("second-token").await;
    let connection = tokio::time::timeout(PATIENCE, connecting)
        .await
        .expect("the connect ends")
        .expect("the connect task runs")
        .expect("the second token opens the link");
    assert!(connection.initialize_response().compatible);

    let connecting = tokio::spawn(DaemonConnection::connect(DaemonEndpoint::new(
        run_folder.clone(),
    )));
    let mut third = accept(&listener).await;
    let id = read_initialize(&mut third, "second-token").await;
    third.refuse(&id, RefusalCode::AuthTokenInvalid).await;
    let refused = tokio::time::timeout(PATIENCE, connecting)
        .await
        .expect("an unchanged token is not retried")
        .expect("the connect task runs");
    assert!(
        matches!(&refused, Err(ClientError::Remote(remote)) if remote.data.as_ref().is_some_and(
            |data| data.refusal == RefusalCode::AuthTokenInvalid.as_str()
        )),
        "{:?}",
        refused.err()
    );
}

#[tokio::test]
async fn a_run_folder_that_is_not_a_private_folder_is_refused_before_any_byte_is_written() {
    let folder = tempfile::tempdir().expect("a temporary folder");
    // A file where the folder should be is no folder this account keeps to itself.
    let not_a_folder = folder.path().join("not-a-folder");
    std::fs::write(&not_a_folder, "").expect("the file is written");
    let run_folder = run_folder(&not_a_folder, folder.path());
    let listener = listen(&run_folder);
    std::fs::write(&run_folder.token_path, "a-token").expect("the token is written");

    let connecting = tokio::spawn(DaemonConnection::connect(DaemonEndpoint::new(run_folder)));
    let mut stream = tokio::time::timeout(PATIENCE, listener.accept())
        .await
        .expect("the client connects")
        .expect("the connection is accepted");
    let mut received = Vec::new();
    tokio::time::timeout(PATIENCE, stream.read_to_end(&mut received))
        .await
        .expect("the client closes the connection")
        .expect("the connection reads");
    assert!(
        received.is_empty(),
        "the client wrote {} bytes",
        received.len()
    );
    let refused = connecting.await.expect("the connect task runs");
    assert!(
        matches!(refused, Err(ClientError::RunFolder(_))),
        "{:?}",
        refused.err()
    );
}

#[tokio::test(start_paused = true)]
async fn a_lost_link_reopens_on_the_schedule_and_calls_settle_once_it_is_down() {
    let folder = tempfile::tempdir().expect("a temporary folder");
    let private = folder.path().join("run");
    sidekicks_platforms::create_private_folder(&private).expect("the run folder is made private");
    let run_folder = run_folder(&private, &private);
    let listener = listen(&run_folder);
    std::fs::write(&run_folder.token_path, "token").expect("the token is written");
    let connecting = tokio::spawn(DaemonConnection::connect(DaemonEndpoint::new(
        run_folder.clone(),
    )));
    let mut daemon = accept(&listener).await;
    daemon.answer_initialize_with_token("token").await;
    let connection = connecting
        .await
        .expect("the connect task runs")
        .expect("the link opens");
    let mut states = connection.state_changes();
    let never = CancellationToken::new();
    let call = |marker: &str| {
        connection.client().call_raw(
            raw_request(&SessionRead::DESCRIPTOR, &json!({ "held": marker })),
            &never,
        )
    };

    // The first loss: the daemon accepts the first attempt and never answers its handshake.
    // The schedule starts once the supervisor sees the loss, which it reports as reconnecting.
    drop(daemon);
    wait_for_state(&mut states, ConnectionState::Reconnecting).await;
    let lost_at = Instant::now();
    let held = call("through the reopen");
    let (mut silent, first_attempt_at) = accept_attempt(&listener).await;
    assert_waited(
        first_attempt_at - lost_at,
        Duration::from_millis(LINK_REOPEN_BACKOFF_MS[0]),
    );
    silent.next_message().await;
    let (mut daemon, second_attempt_at) = accept_attempt(&listener).await;
    assert_waited(
        second_attempt_at - first_attempt_at,
        HANDSHAKE_DEADLINE + Duration::from_millis(LINK_REOPEN_BACKOFF_MS[1]),
    );
    daemon.answer_initialize_with_token("token").await;
    let resent = daemon.next_message().await;
    assert_eq!(resent["params"]["held"], "through the reopen");
    daemon.answer(&resent["id"], json!({})).await;
    held.await
        .expect("the held call goes out on the reopened link");
    wait_for_state(&mut states, ConnectionState::Open).await;

    // The second loss with nobody listening: every attempt fails, and the connection is down.
    drop(listener);
    drop(silent);
    drop(daemon);
    wait_for_state(&mut states, ConnectionState::Reconnecting).await;
    let lost_at = Instant::now();
    let held = call("until down");
    assert!(
        matches!(held.await, Err(ClientError::Unavailable { .. })),
        "a held call settles once the connection is down"
    );
    let schedule: u64 = LINK_REOPEN_BACKOFF_MS.iter().sum();
    assert_waited(lost_at.elapsed(), Duration::from_millis(schedule));
    assert_eq!(connection.state(), ConnectionState::Down);
    assert!(
        matches!(
            call("while down").now_or_never(),
            Some(Err(ClientError::Unavailable { .. }))
        ),
        "a call made while down settles at once"
    );

    // A retry starts the schedule again from its first wait.
    let listener = listen(&run_folder);
    let retried_at = Instant::now();
    connection.retry();
    let (mut daemon, attempt_at) = accept_attempt(&listener).await;
    assert_waited(
        attempt_at - retried_at,
        Duration::from_millis(LINK_REOPEN_BACKOFF_MS[0]),
    );
    daemon.answer_initialize_with_token("token").await;
    wait_for_state(&mut states, ConnectionState::Open).await;
}
