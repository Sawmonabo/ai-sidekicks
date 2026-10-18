//! Opening a daemon connection: over a real local socket, the token is read at each connect and
//! once more when the daemon refuses it, and a run folder that is not this account's alone is
//! refused before the client writes a byte; over in-memory streams on the paused clock, the link
//! watch keeps a link that frames still reach, and a lost link is opened again on the client's
//! schedule, each attempt held to the handshake deadline, until the reopen window passes and only a
//! retry reopens it.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use futures::FutureExt as _;
use interprocess::local_socket::tokio::{Listener, Stream};
use interprocess::local_socket::traits::tokio::Listener as _;
use interprocess::local_socket::{GenericFilePath, ListenerOptions, ToFsName as _};
use serde_json::json;
use sidekicks_client::daemon_connection::{
    ConnectionState, DaemonConnection, DaemonConnector, DaemonEndpoint, HANDSHAKE_DEADLINE,
    LINK_REOPEN_BACKOFF_MS, LINK_REOPEN_WINDOW,
};
use sidekicks_client::error::{ClientError, LinkFault};
use sidekicks_contracts::jsonrpc::message::ConnectionUnavailableReason;
use sidekicks_contracts::jsonrpc::negotiation::NegotiationText;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::method::Method;
use sidekicks_contracts::session::methods::SessionRead;
use sidekicks_platforms::DaemonRunFolder;
use tokio::io::{AsyncReadExt as _, DuplexStream};
use tokio::sync::{mpsc, watch};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::helpers::{ScriptedDaemon, raw_request};

/// How long a test waits for the client before it counts as stuck.
const PATIENCE: Duration = Duration::from_secs(10);

/// Longer than the reopen window with a handshake deadline, on the paused clock.
const SCHEDULE_PATIENCE: Duration = Duration::from_secs(300);

/// The slack a paused clock's millisecond timer ticks add to a wait.
const TICK_SLACK: Duration = Duration::from_millis(5);

/// The token the in-memory daemon wrote.
const TOKEN: &str = "token";

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

/// A daemon the client reaches over in-memory streams: each attempt hands the test the daemon's
/// half, or, while nobody listens, fails at once as a daemon that is not running does.
struct MemoryConnector {
    attempts: mpsc::UnboundedSender<DuplexStream>,
    is_listening: Arc<AtomicBool>,
    attempted: Arc<AtomicUsize>,
}

impl DaemonConnector for MemoryConnector {
    type Stream = DuplexStream;

    async fn open_stream(&self) -> Result<DuplexStream, ClientError> {
        self.attempted.fetch_add(1, Ordering::SeqCst);
        let not_listening = || ClientError::Unavailable {
            reason: ConnectionUnavailableReason::NotListening,
            cause: LinkFault::PeerClosed,
        };
        if !self.is_listening.load(Ordering::SeqCst) {
            return Err(not_listening());
        }
        let (client_side, daemon_side) = tokio::io::duplex(1 << 20);
        if self.attempts.send(daemon_side).is_err() {
            return Err(not_listening());
        }
        Ok(client_side)
    }

    async fn read_token(&self) -> Result<NegotiationText, ClientError> {
        Ok(NegotiationText::new(TOKEN.to_owned()).expect("the test's token is a token"))
    }
}

/// The test's side of a [`MemoryConnector`]: the attempts it accepts, whether anyone listens, and
/// how many attempts the client made.
struct MemoryDaemons {
    attempts: mpsc::UnboundedReceiver<DuplexStream>,
    is_listening: Arc<AtomicBool>,
    attempted: Arc<AtomicUsize>,
}

impl MemoryDaemons {
    /// Accepts the client's next attempt and answers when it came.
    async fn accept(&mut self) -> (ScriptedDaemon<DuplexStream>, Instant) {
        let stream = tokio::time::timeout(SCHEDULE_PATIENCE, self.attempts.recv())
            .await
            .expect("the client tries again")
            .expect("the connector is held");
        (ScriptedDaemon::new(stream), Instant::now())
    }

    fn listen(&self, is_listening: bool) {
        self.is_listening.store(is_listening, Ordering::SeqCst);
    }

    fn attempted(&self) -> usize {
        self.attempted.load(Ordering::SeqCst)
    }
}

fn memory_daemons() -> (MemoryConnector, MemoryDaemons) {
    let (sender, receiver) = mpsc::unbounded_channel();
    let is_listening = Arc::new(AtomicBool::new(true));
    let attempted = Arc::new(AtomicUsize::new(0));
    let connector = MemoryConnector {
        attempts: sender,
        is_listening: Arc::clone(&is_listening),
        attempted: Arc::clone(&attempted),
    };
    let daemons = MemoryDaemons {
        attempts: receiver,
        is_listening,
        attempted,
    };
    (connector, daemons)
}

/// Connects over `connector` and answers the handshake; answers the connection, its daemon and
/// when the link opened.
async fn connect(
    connector: MemoryConnector,
    daemons: &mut MemoryDaemons,
) -> (DaemonConnection, ScriptedDaemon<DuplexStream>, Instant) {
    let connecting = tokio::spawn(DaemonConnection::connect(connector));
    let (mut daemon, opened_at) = daemons.accept().await;
    daemon.answer_initialize_with_token(TOKEN).await;
    let connection = connecting
        .await
        .expect("the connect task runs")
        .expect("the link opens");
    (connection, daemon, opened_at)
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

#[tokio::test(start_paused = true)]
async fn a_frame_while_the_ping_waits_keeps_the_link_and_reports_it_open() {
    let (connector, mut daemons) = memory_daemons();
    let (connection, mut daemon, opened_at) = connect(connector, &mut daemons).await;
    let mut states = connection.state_changes();

    let ping = daemon.next_message().await;
    assert_eq!(ping["method"], "daemon.ping");
    assert_waited(opened_at.elapsed(), Duration::from_secs(5));
    wait_for_state(&mut states, ConnectionState::Quiet).await;

    // Unanswered, the ping would lose the link 20 s after its last frame; one frame 18 s in, an
    // answer to no call, moves that on, and the watch reports the link open at the old deadline.
    tokio::time::sleep_until(opened_at + Duration::from_secs(18)).await;
    daemon.answer(&json!(9_999), json!({})).await;
    let framed_at = Instant::now();
    wait_for_state(&mut states, ConnectionState::Open).await;
    assert_waited(opened_at.elapsed(), Duration::from_secs(20));
    wait_for_state(&mut states, ConnectionState::Reconnecting).await;
    assert_waited(framed_at.elapsed(), Duration::from_secs(20));
}

#[tokio::test(start_paused = true)]
async fn a_lost_link_reopens_on_the_schedule_until_its_window_passes_then_only_a_retry_reopens() {
    let (connector, mut daemons) = memory_daemons();
    let (connection, daemon, _opened_at) = connect(connector, &mut daemons).await;
    let mut states = connection.state_changes();
    let never = CancellationToken::new();
    let call = |marker: &str| {
        connection.client().call_raw(
            raw_request(&SessionRead::DESCRIPTOR, &json!({ "held": marker })),
            &never,
        )
    };

    // The first loss: the daemon accepts the first attempt and never answers its handshake.
    drop(daemon);
    wait_for_state(&mut states, ConnectionState::Reconnecting).await;
    let lost_at = Instant::now();
    let held = call("through the reopen");
    let (mut silent, first_attempt_at) = daemons.accept().await;
    assert_waited(
        first_attempt_at - lost_at,
        Duration::from_millis(LINK_REOPEN_BACKOFF_MS[0]),
    );
    silent.next_message().await;
    let (mut daemon, second_attempt_at) = daemons.accept().await;
    assert_waited(
        second_attempt_at - first_attempt_at,
        HANDSHAKE_DEADLINE + Duration::from_millis(LINK_REOPEN_BACKOFF_MS[1]),
    );
    daemon.answer_initialize_with_token(TOKEN).await;
    let resent = daemon.next_message().await;
    assert_eq!(resent["params"]["held"], "through the reopen");
    daemon.answer(&resent["id"], json!({})).await;
    held.await
        .expect("the held call goes out on the reopened link");
    wait_for_state(&mut states, ConnectionState::Open).await;

    // The second loss with nobody listening: the client keeps trying, reconnecting, for the whole
    // window, then the connection is down and a held call settles.
    daemons.listen(false);
    drop(silent);
    drop(daemon);
    wait_for_state(&mut states, ConnectionState::Reconnecting).await;
    let lost_at = Instant::now();
    let attempted_before = daemons.attempted();
    let mut held = Box::pin(call("until down"));
    tokio::time::sleep(LINK_REOPEN_WINDOW / 2).await;
    assert_eq!(connection.state(), ConnectionState::Reconnecting);
    assert!((&mut held).now_or_never().is_none(), "the call is held");
    assert!(
        matches!(held.await, Err(ClientError::Unavailable { .. })),
        "a held call settles once the connection is down"
    );
    assert_waited(lost_at.elapsed(), LINK_REOPEN_WINDOW);
    assert_eq!(connection.state(), ConnectionState::Down);
    // Each wait of the schedule, then its last wait again while an attempt starts in the window:
    // at 0.1, 0.4, 1.4, 4.4 and 14.4 s, then every 10 s to 114.4 s.
    assert_eq!(daemons.attempted() - attempted_before, 15);
    assert!(
        matches!(
            call("while down").now_or_never(),
            Some(Err(ClientError::Unavailable { .. }))
        ),
        "a call made while down settles at once"
    );

    // A retry starts the schedule again from its first wait; a second press starts nothing more.
    daemons.listen(true);
    let retried_at = Instant::now();
    connection.retry();
    connection.retry();
    let (mut daemon, attempt_at) = daemons.accept().await;
    assert_waited(
        attempt_at - retried_at,
        Duration::from_millis(LINK_REOPEN_BACKOFF_MS[0]),
    );
    daemon.answer_initialize_with_token(TOKEN).await;
    wait_for_state(&mut states, ConnectionState::Open).await;

    // So the next time the connection is down it stays down until a retry.
    daemons.listen(false);
    drop(daemon);
    wait_for_state(&mut states, ConnectionState::Down).await;
    let attempted_when_down = daemons.attempted();
    tokio::time::sleep(LINK_REOPEN_WINDOW).await;
    assert_eq!(connection.state(), ConnectionState::Down);
    assert_eq!(daemons.attempted(), attempted_when_down);
}
