//! Opening a daemon connection: over a real local socket, the token is read at each connect and
//! once more when the daemon refuses it, and a run folder that is not this account's alone is
//! refused before the client writes a byte; over in-memory streams on the paused clock, the link
//! watch keeps a link that frames still reach, and a lost link is opened again on the client's
//! schedule, each attempt held to the handshake deadline, until the reopen window passes and only a
//! retry reopens it, and a close while an attempt runs ends it and starts no other. A daemon
//! repairing its database file keeps the link it refused for the repairing form's stop, and each of
//! its refusals moves the handshake wait's deadline on.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use futures::FutureExt as _;
use interprocess::local_socket::tokio::Stream;
use interprocess::local_socket::traits::tokio::Listener as _;
use serde_json::json;
use sidekicks_client::daemon_connection::handshake_wait::wait_for_handshake;
use sidekicks_client::daemon_connection::{
    ConnectionState, DaemonConnection, DaemonConnector, DaemonEndpoint, HANDSHAKE_DEADLINE,
    LINK_REOPEN_BACKOFF_MS, LINK_REOPEN_WINDOW, OpenedConnection,
};
use sidekicks_client::error::{ClientError, LinkFault};
use sidekicks_contracts::jsonrpc::message::ConnectionUnavailableReason;
use sidekicks_contracts::jsonrpc::negotiation::NegotiationText;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::method::Method;
use sidekicks_contracts::session::methods::SessionRead;
use tokio::io::{AsyncReadExt as _, DuplexStream};
use tokio::sync::{mpsc, watch};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::helpers::{PATIENCE, ScriptedDaemon, accept, listen, raw_request, run_folder};

/// Longer than the reopen window with a handshake deadline, on the paused clock.
const SCHEDULE_PATIENCE: Duration = Duration::from_secs(300);

/// The slack a paused clock's millisecond timer ticks add to a wait.
const TICK_SLACK: Duration = Duration::from_millis(5);

/// The token the in-memory daemon wrote.
const TOKEN: &str = "token";

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

/// When each attempt to open a stream started.
type AttemptTimes = Arc<Mutex<Vec<Instant>>>;

/// A daemon the client reaches over in-memory streams: each attempt is timed and hands the test the
/// daemon's half, or, while nobody listens, fails at once as a daemon that is not running does.
#[derive(Clone)]
struct MemoryConnector {
    attempts: mpsc::UnboundedSender<DuplexStream>,
    is_listening: Arc<AtomicBool>,
    attempted_at: AttemptTimes,
}

impl DaemonConnector for MemoryConnector {
    type Stream = DuplexStream;

    #[expect(
        clippy::unused_async_trait_impl,
        reason = "the in-memory daemon answers at once, where the real connector awaits a socket"
    )]
    async fn open_stream(&self) -> Result<DuplexStream, ClientError> {
        self.attempted_at
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(Instant::now());
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

    #[expect(
        clippy::unused_async_trait_impl,
        reason = "the test's token is a constant, where the real connector reads a file"
    )]
    async fn read_token(&self) -> Result<NegotiationText, ClientError> {
        Ok(NegotiationText::new(TOKEN.to_owned()).expect("the test's token is a token"))
    }
}

/// The test's side of a [`MemoryConnector`]: the attempts it accepts, whether anyone listens, and
/// when the client made each attempt.
struct MemoryDaemons {
    attempts: mpsc::UnboundedReceiver<DuplexStream>,
    is_listening: Arc<AtomicBool>,
    attempted_at: AttemptTimes,
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

    /// When each attempt the client made started, the first connect's among them.
    fn attempted_at(&self) -> Vec<Instant> {
        self.attempted_at
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

fn memory_daemons() -> (MemoryConnector, MemoryDaemons) {
    let (sender, receiver) = mpsc::unbounded_channel();
    let is_listening = Arc::new(AtomicBool::new(true));
    let attempted_at = AttemptTimes::default();
    let connector = MemoryConnector {
        attempts: sender,
        is_listening: Arc::clone(&is_listening),
        attempted_at: Arc::clone(&attempted_at),
    };
    let daemons = MemoryDaemons {
        attempts: receiver,
        is_listening,
        attempted_at,
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

/// Reads the client's next `daemon.ping` and answers its id and how long after `since` it came.
async fn next_ping(
    daemon: &mut ScriptedDaemon<DuplexStream>,
    since: Instant,
) -> (serde_json::Value, Duration) {
    let ping = daemon.next_message().await;
    assert_eq!(ping["method"], "daemon.ping");
    (ping["id"].clone(), since.elapsed())
}

#[tokio::test(start_paused = true)]
async fn any_frame_from_the_daemon_reports_a_quiet_link_open_and_keeps_it() {
    let (connector, mut daemons) = memory_daemons();
    let (connection, mut daemon, opened_at) = connect(connector, &mut daemons).await;
    let mut states = connection.state_changes();

    // A daemon that refuses the ping still answered it: the link is open again at once.
    let (id, waited) = next_ping(&mut daemon, opened_at).await;
    assert_waited(waited, Duration::from_secs(5));
    wait_for_state(&mut states, ConnectionState::Quiet).await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    daemon.refuse(&id, RefusalCode::RequestMethodNotFound).await;
    let refused_at = Instant::now();
    wait_for_state(&mut states, ConnectionState::Open).await;
    assert_waited(refused_at.elapsed(), Duration::ZERO);

    // An answer that does not read leaves the link quiet; a later frame, an answer to no call,
    // reports it open when the quiet timer finds it.
    let (id, waited) = next_ping(&mut daemon, refused_at).await;
    assert_waited(waited, Duration::from_secs(5));
    wait_for_state(&mut states, ConnectionState::Quiet).await;
    daemon.answer(&id, json!({ "unexpected": true })).await;
    let misread_at = Instant::now();
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(connection.state(), ConnectionState::Quiet);
    daemon.answer(&json!(9_998), json!({})).await;
    let framed_at = Instant::now();
    wait_for_state(&mut states, ConnectionState::Open).await;
    assert_waited(misread_at.elapsed(), Duration::from_secs(5));

    // Unanswered, the next ping would lose the link 20 s after its last frame; one frame 18 s in
    // moves that on, and the watch reports the link open at the old deadline.
    let (_id, waited) = next_ping(&mut daemon, framed_at).await;
    assert_waited(waited, Duration::from_secs(5));
    wait_for_state(&mut states, ConnectionState::Quiet).await;
    tokio::time::sleep_until(framed_at + Duration::from_secs(18)).await;
    daemon.answer(&json!(9_999), json!({})).await;
    let late_frame_at = Instant::now();
    wait_for_state(&mut states, ConnectionState::Open).await;
    assert_waited(framed_at.elapsed(), Duration::from_secs(20));
    wait_for_state(&mut states, ConnectionState::Reconnecting).await;
    assert_waited(late_frame_at.elapsed(), Duration::from_secs(20));
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
    let attempted_before = daemons.attempted_at().len();
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
    let last_wait = LINK_REOPEN_BACKOFF_MS[LINK_REOPEN_BACKOFF_MS.len() - 1];
    let mut expected_waits = LINK_REOPEN_BACKOFF_MS.to_vec();
    while Duration::from_millis(expected_waits.iter().sum::<u64>() + last_wait) < LINK_REOPEN_WINDOW
    {
        expected_waits.push(last_wait);
    }
    let mut previous = lost_at;
    let waits: Vec<Duration> = daemons.attempted_at()[attempted_before..]
        .iter()
        .map(|attempted_at| {
            let wait = *attempted_at - previous;
            previous = *attempted_at;
            wait
        })
        .collect();
    assert_eq!(expected_waits.len(), 15);
    assert_eq!(waits.len(), expected_waits.len(), "{waits:?}");
    for (wait, expected) in waits.into_iter().zip(expected_waits) {
        assert_waited(wait, Duration::from_millis(expected));
    }
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
    let attempted_when_down = daemons.attempted_at().len();
    tokio::time::sleep(LINK_REOPEN_WINDOW).await;
    assert_eq!(connection.state(), ConnectionState::Down);
    assert_eq!(daemons.attempted_at().len(), attempted_when_down);
}

#[tokio::test(start_paused = true)]
async fn a_close_while_an_attempt_runs_ends_the_attempt_and_starts_no_other() {
    let (connector, mut daemons) = memory_daemons();
    let (connection, daemon, _opened_at) = connect(connector, &mut daemons).await;
    let mut states = connection.state_changes();

    drop(daemon);
    wait_for_state(&mut states, ConnectionState::Reconnecting).await;
    // The daemon takes the attempt's stream and never answers its handshake.
    let (mut silent, _attempt_at) = daemons.accept().await;
    silent.next_message().await;
    tokio::time::timeout(PATIENCE, connection.close())
        .await
        .expect("the close ends while the attempt runs");
    silent.assert_closed().await;

    let attempted_at_close = daemons.attempted_at().len();
    tokio::time::sleep(LINK_REOPEN_WINDOW).await;
    assert_eq!(daemons.attempted_at().len(), attempted_at_close);
}

#[tokio::test]
async fn a_repairing_daemon_keeps_the_refused_link_and_the_stop_sent_on_it_reaches_the_daemon() {
    let folder = tempfile::tempdir().expect("a temporary folder");
    let private = folder.path().join("run");
    sidekicks_platforms::create_private_folder(&private).expect("the run folder is made private");
    let run_folder = run_folder(&private, &private);
    let listener = listen(&run_folder);
    std::fs::write(&run_folder.token_path, "repair-token").expect("the token is written");

    let connecting = tokio::spawn(DaemonConnection::connect_or_repairing(DaemonEndpoint::new(
        run_folder,
    )));
    let mut daemon = accept(&listener).await;
    let id = read_initialize(&mut daemon, "repair-token").await;
    let progress = json!({ "progress": { "done": 3, "total": 40 } });
    daemon
        .refuse_with_fields(&id, RefusalCode::DaemonRepairing, progress.clone())
        .await;
    let opened = tokio::time::timeout(PATIENCE, connecting)
        .await
        .expect("the connect ends")
        .expect("the connect task runs")
        .expect("the repairing daemon's refusal keeps its link");
    let OpenedConnection::Repairing(repairing) = opened else {
        panic!("a repairing daemon opened as a running one");
    };
    assert_eq!(
        serde_json::to_value(repairing.details()).expect("the details write as JSON"),
        progress
    );

    let stopping = tokio::spawn(repairing.stop());
    let stop = tokio::time::timeout(PATIENCE, daemon.next_message())
        .await
        .expect("the stop reaches the daemon on the refused link");
    assert_eq!(stop["method"], "daemon.stop");
    daemon
        .answer(&stop["id"], json!({ "accepted": true }))
        .await;
    tokio::time::timeout(PATIENCE, stopping)
        .await
        .expect("the stop ends")
        .expect("the stop task runs")
        .expect("the daemon took the stop");
}

#[tokio::test(start_paused = true)]
async fn each_repairing_answer_moves_the_handshake_wait_deadline_on() {
    let (connector, mut daemons) = memory_daemons();
    let handed = Arc::new(Mutex::new(Vec::new()));
    let started_at = Instant::now();
    let waiting = tokio::spawn(wait_for_handshake(
        connector,
        HANDSHAKE_DEADLINE,
        {
            let handed = Arc::clone(&handed);
            move |details| {
                handed
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push(serde_json::to_value(details).expect("the details write as JSON"));
            }
        },
        std::future::pending::<()>(),
    ));

    // The daemon takes the first attempt and answers that it is repairing 9 s into the wait;
    // nothing answers after that.
    let (mut daemon, _attempt_at) = daemons.accept().await;
    let request = daemon.next_message().await;
    tokio::time::sleep_until(started_at + Duration::from_secs(9)).await;
    daemons.listen(false);
    let progress = json!({ "progress": { "done": 1, "total": 2 } });
    daemon
        .refuse_with_fields(
            &request["id"],
            RefusalCode::DaemonRepairing,
            progress.clone(),
        )
        .await;
    let refused_at = Instant::now();

    tokio::time::sleep_until(started_at + HANDSHAKE_DEADLINE + Duration::from_secs(1)).await;
    assert!(
        !waiting.is_finished(),
        "the repairing answer keeps the wait alive past its first deadline"
    );
    let ended = tokio::time::timeout(SCHEDULE_PATIENCE, waiting)
        .await
        .expect("the wait ends")
        .expect("the wait task runs");
    assert!(
        matches!(ended, Err(ClientError::Unavailable { .. })),
        "the wait ends unanswered"
    );
    assert_waited(refused_at.elapsed(), HANDSHAKE_DEADLINE);
    assert_eq!(
        *handed.lock().unwrap_or_else(PoisonError::into_inner),
        vec![progress]
    );
}
