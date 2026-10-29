use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use futures::{SinkExt as _, StreamExt as _};
use rstest::rstest;
use rusqlite::Connection;
use serde_json::{Value, json};
use sidekicks_client::daemon_connection::{DaemonConnection, DaemonEndpoint};
use sidekicks_client::transport::local_socket::connect_local_socket;
use sidekicks_contracts::daemon::config::{DaemonConfigUpdate, DaemonConfigUpdateRequest};
use sidekicks_contracts::daemon::lifecycle::{DaemonRestart, DaemonStop};
use sidekicks_contracts::daemon::status::{DaemonProcessState, DaemonStatusRead};
use sidekicks_contracts::jsonrpc::framing::frame::{Frame, FrameCodec, LaneId};
use sidekicks_contracts::jsonrpc::framing::incoming::IncomingLanes;
use sidekicks_contracts::jsonrpc::framing::{MAX_CHUNK_BYTES, MessageBody};
use sidekicks_contracts::jsonrpc::negotiation::CURRENT_PROTOCOL_VERSION;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::method::Method as _;
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_ipc::caller_process::system_reader::ProcessTableReader;
use sidekicks_platforms::{
    CAN_BIND_A_SOCKET_LISTENER, CredentialStore, DaemonRunFolder, LeftoverSweep, SocketPathRefused,
    askpass_socket_path, check_socket_path, create_missing_private_folders, process_identity,
    replace_file_atomically,
};
use sidekicks_provider::driver::PROVIDER_REGISTRATIONS;
use sidekicks_provider::driver::daemon_stop::DaemonStopIntent;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::test_registry::{keep_terminal_service, test_driver_services};
use sidekicks_store::credential_store::items::{SecretItems, SecretItemsStart};
use sidekicks_store::credential_store::os::TestStoreAccess;
use sidekicks_store::data_folder::data_folder;
use sidekicks_store::data_folder::lock::DataFolderLock;
use sidekicks_store::database::connection::writer_open::{
    DAEMON_DATABASE_FILE_NAME, open_database,
};
use tempfile::TempDir;
use tokio_util::codec::Framed;
use tokio_util::sync::CancellationToken;

use super::DaemonProcess;
use super::database::DatabaseFileOpenError;
use super::start_error::{DaemonStartError, DaemonStartFailure};
use crate::daemon::crash::monitor::{
    CRASH_DUMPS_FOLDER_NAME, CRASH_MONITOR_MODE, crash_monitor_socket_path, serve_crash_monitor,
};
use crate::daemon::process::start_options::{DaemonStartOptions, ProviderBaseEnvironment};
use crate::daemon::release_version::this_build_release_version;
use crate::daemon::schema::schema_parts;
use crate::daemon::service_log::open_service_log;
use crate::data_acts::erase::{DataErase, DataEraseDeps};

// The variable the stand-in crash monitor reads its socket's path from.
const MONITOR_SOCKET_VARIABLE: &str = "SIDEKICKS_TEST_CRASH_MONITOR_SOCKET";

// The longest a started daemon's test waits for the erase to end the process.
const ERASE_WAIT: Duration = Duration::from_secs(30);

// The longest a test waits for an asked stop to reach the process and for the stop to run: the
// caller's wait for the service to exit.
const STOP_WAIT: Duration = Duration::from_secs(10);

// The crash monitor the daemon starts in these tests: this test binary, run through a script as
// the daemon's own program, serving the socket the mode's argument names; the script fails every
// other mode, the search index's build among them. Run only that way.
#[test]
#[ignore = "the started daemon's crash monitor, run through its script"]
fn crash_monitor_stand_in() {
    let Some(socket_path) = std::env::var_os(MONITOR_SOCKET_VARIABLE).map(PathBuf::from) else {
        return;
    };
    let dumps_folder = socket_path
        .parent()
        .expect("the socket sits in its run folder")
        .join(CRASH_DUMPS_FOLDER_NAME);
    serve_crash_monitor(&socket_path, &dumps_folder).expect("the stand-in monitor serves");
}

// A temporary home the daemon starts on, its run folder at `run_folder_path`, beside the data
// folder as a runtime folder sits, the script that runs the stand-in monitor, and the environment
// its providers start in.
struct TestHome {
    home: TempDir,
    run_folder: DaemonRunFolder,
    daemon_program: PathBuf,
    provider_environment: Arc<[(String, String)]>,
}

impl TestHome {
    fn new() -> Self {
        let home = tempfile::tempdir().expect("a temporary home");
        let run_folder_path = home.path().join("run");
        Self::with_run_folder(home, run_folder_path)
    }

    fn with_run_folder(home: TempDir, run_folder_path: PathBuf) -> Self {
        let test_path = module_path!()
            .split_once("::")
            .map(|(_crate, path)| path)
            .expect("the module path names its crate");
        let program = std::env::current_exe().expect("the test program names itself");
        let daemon_program = home.path().join("daemon-program");
        let script = format!(
            "#!/bin/sh\n[ \"$1\" = {CRASH_MONITOR_MODE} ] || exit 1\n\
             {MONITOR_SOCKET_VARIABLE}=\"$2\" exec '{}' --exact \
             {test_path}::crash_monitor_stand_in --include-ignored >/dev/null\n",
            program.display()
        );
        replace_file_atomically(
            &daemon_program,
            script.as_bytes(),
            0o755,
            LeftoverSweep::Unswept,
        )
        .expect("the stand-in's script is written");
        Self {
            home,
            run_folder: DaemonRunFolder {
                socket_path: run_folder_path.join("daemon.sock"),
                token_path: run_folder_path.join("daemon.token"),
                status_path: run_folder_path.join("service-status.json"),
                folder_path: run_folder_path,
            },
            daemon_program,
            provider_environment: Arc::from([]),
        }
    }

    // This home with its providers started in `environment` in place of none.
    fn with_provider_environment(self, environment: Vec<(String, String)>) -> Self {
        Self {
            provider_environment: environment.into(),
            ..self
        }
    }

    fn data_folder(&self) -> PathBuf {
        data_folder(self.home.path())
    }

    fn monitor_socket_path(&self) -> PathBuf {
        crash_monitor_socket_path(&self.run_folder.folder_path, std::process::id())
    }

    // Starts the daemon on this home, its providers in its providers' environment, its stop
    // `stop`.
    async fn start(&self, stop: CancellationToken) -> Result<DaemonProcess, DaemonStartFailure> {
        let data_folder = self.data_folder();
        create_missing_private_folders(&data_folder).expect("the data folder is made");
        DaemonProcess::start(DaemonStartOptions {
            home_folder: self.home.path().to_path_buf(),
            data_folder_lock: DataFolderLock::take(&data_folder).expect("the data folder is free"),
            run_folder: self.run_folder.clone(),
            daemon_program: self.daemon_program.clone(),
            process_identity: process_identity(std::process::id())
                .expect("this process reads")
                .expect("this process runs"),
            version: this_build_release_version(),
            caller_process_reader: Arc::new(
                ProcessTableReader::for_this_program().expect("the caller reader is built"),
            ),
            stop,
            base_environment: ProviderBaseEnvironment::Given(Arc::clone(
                &self.provider_environment,
            )),
            credential_store: TestStoreAccess::new(CredentialStore::in_memory()) as _,
            service_log_files: open_service_log(&data_folder, io::sink()).files(),
            provider_registrations: PROVIDER_REGISTRATIONS,
        })
        .await
    }
}

// An erase over a started daemon runs the stop's two steps on the task that owns the process: the
// socket and the crash monitor's socket are gone and the data folder deleted once the erase ends
// the process, and the stop that follows finds nothing left and fails nothing. Killed by an erase
// step that never reaches the process, by a step that does not close what it names, and by a
// stop that closes a part the erase already closed again.
#[tokio::test(flavor = "multi_thread")]
async fn an_erase_over_a_started_daemon_closes_it_and_the_stop_after_fails_nothing() {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let home = TestHome::new();
    let mut process = home
        .start(CancellationToken::new())
        .await
        .expect("the daemon starts");
    assert!(home.run_folder.socket_path.exists() && home.monitor_socket_path().exists());
    let end_process = process.accept_stop();
    let erase = Arc::new(DataErase::new(DataEraseDeps {
        data_folder: home.data_folder(),
        secret_items: SecretItems::new(SecretItemsStart {
            data_folder: home.data_folder(),
            runs_while_logged_out: false,
            access: TestStoreAccess::new(CredentialStore::in_memory()) as _,
            call_timeout: Duration::from_secs(5),
        })
        .expect("the system gives random bytes"),
        providers: Arc::new(ProviderRegistry::register_from(
            &[],
            &test_driver_services(),
        )),
        stop_work: process.stop_work_step(),
        close_data_folder: process.close_data_folder_step(),
        end_process: Arc::new(move || end_process(DaemonStopIntent::Stop)),
    }));

    erase.begin().await.expect("the erase starts");
    let intent = tokio::time::timeout(ERASE_WAIT, process.wait_for_stop())
        .await
        .expect("the erase ends the process");

    assert_eq!(intent, DaemonStopIntent::Stop);
    assert!(!home.run_folder.socket_path.exists(), "the socket is gone");
    assert!(
        !home.monitor_socket_path().exists(),
        "the crash monitor's socket is gone"
    );
    assert!(!home.data_folder().exists(), "the data folder is deleted");
    process
        .stop(intent)
        .await
        .expect("the stop after the erase fails nothing");
}

// A run folder whose longest socket path is one byte past the system's bound fails the start
// before any step: no folder is made and no monitor started. One byte shorter starts, removing
// the socket an ended service's monitor left, and its stop leaves neither socket. Killed by the
// path check removed, where the start fails later at the crash monitor after making the folder,
// and by the ended service's socket kept.
#[tokio::test(flavor = "multi_thread")]
async fn a_run_folder_too_long_for_its_sockets_fails_the_start_before_any_step() {
    let Err(SocketPathRefused::TooLong { limit, .. }) =
        check_socket_path(&PathBuf::from("/".repeat(4096)))
    else {
        panic!("a path of 4096 bytes is past every system's bound");
    };
    let longest_name = crash_monitor_socket_path(Path::new(""), std::process::id())
        .as_os_str()
        .len()
        .max("daemon.sock".len())
        .max(askpass_socket_path(Path::new("")).as_os_str().len());
    let home = tempfile::tempdir().expect("a temporary home");
    // The folder, a separator and the longest name come to one byte past the bound.
    let padding = (limit - longest_name)
        .checked_sub(home.path().as_os_str().len() + 1)
        .expect("the temporary home is short enough to pad");
    let too_long = home.path().join("r".repeat(padding));
    let fits = home.path().join("r".repeat(padding - 1));
    let refused = TestHome::with_run_folder(home, too_long.clone());

    let failure = refused
        .start(CancellationToken::new())
        .await
        .err()
        .expect("the start fails");

    assert!(
        matches!(
            failure.failures.original(),
            DaemonStartError::SocketPathRefused {
                source: SocketPathRefused::TooLong { .. },
                ..
            }
        ),
        "{:?}",
        failure.failures
    );
    assert!(!too_long.exists(), "no run folder is made");
    // The start one byte shorter binds the socket.
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }

    let started = TestHome::with_run_folder(refused.home, fits);
    create_missing_private_folders(&started.run_folder.folder_path).expect("the run folder");
    let mut ended =
        std::process::Command::new(std::env::current_exe().expect("the test program names itself"))
            .args(["--exact", "no-such-test"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("a process starts");
    let ended_pid = ended.id();
    ended.wait().expect("the process ends");
    let left_socket = crash_monitor_socket_path(&started.run_folder.folder_path, ended_pid);
    std::fs::write(&left_socket, b"").expect("an ended service's socket is left");
    let process = started
        .start(CancellationToken::new())
        .await
        .expect("a run folder one byte shorter starts");
    assert!(
        !left_socket.exists(),
        "the ended service's socket is removed"
    );
    assert!(started.monitor_socket_path().exists());
    process
        .stop(DaemonStopIntent::Stop)
        .await
        .expect("the stop fails nothing");
    assert!(!started.run_folder.socket_path.exists());
    assert!(!started.monitor_socket_path().exists());
}

// A stop asked for before the daemon is ready fails the start as stopped, and the socket it may
// have bound is gone. Killed by both of the start's stop checks removed; the one before the ready
// line alone is not, since the check after the capture answers first.
#[tokio::test(flavor = "multi_thread")]
async fn a_stop_before_ready_fails_the_start_as_stopped_and_leaves_no_socket() {
    let home = TestHome::new();
    let stop = CancellationToken::new();
    stop.cancel();

    let failure = home.start(stop).await.err().expect("the start fails");

    assert!(
        matches!(failure.failures.original(), DaemonStartError::Stopped(_)),
        "{:?}",
        failure.failures
    );
    assert!(!home.run_folder.socket_path.exists());
    assert!(!home.monitor_socket_path().exists());
}

// Sends `method` on a new connection to the socket at `socket_path` before any handshake, and
// answers the daemon's reply.
async fn call_before_handshake(socket_path: &Path, method: &str) -> Value {
    let stream = connect_local_socket(socket_path)
        .await
        .expect("the socket answers");
    let mut frames = Framed::new(stream, FrameCodec);
    let request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": {},
        "protocolVersion": CURRENT_PROTOCOL_VERSION,
    });
    let message = MessageBody {
        json: Bytes::from(serde_json::to_vec(&request).expect("the request writes")),
        attachments: Vec::new(),
    }
    .encode()
    .expect("the request is within its caps");
    for frame in Frame::data_chunks(LaneId::CONTROL, message, MAX_CHUNK_BYTES, false) {
        frames.send(frame).await.expect("the request is sent");
    }
    let mut incoming = IncomingLanes::default();
    loop {
        let frame = frames
            .next()
            .await
            .expect("the connection stays open for the reply")
            .expect("the daemon's frames decode");
        if let Some(reply) = incoming
            .receive(frame)
            .expect("the daemon's frames are well formed")
        {
            return serde_json::from_slice(&reply.body.json).expect("the reply is JSON");
        }
    }
}

// A call on the served socket before its handshake is refused as the handshake's gate refuses
// it, the same call past the handshake answers with this start's data folder, and the stop leaves
// no socket and the data folder free to hold at once. Killed by the chain dispatching past the
// handshake's gate, and by the stop keeping the data folder's hold.
#[tokio::test(flavor = "multi_thread")]
async fn a_call_is_answered_only_past_the_handshake_and_the_stop_lets_the_data_folder_go() {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let home = TestHome::new();
    let process = home
        .start(CancellationToken::new())
        .await
        .expect("the daemon starts");

    let refused = call_before_handshake(
        &home.run_folder.socket_path,
        DaemonStatusRead::DESCRIPTOR.method,
    )
    .await;
    let connection = DaemonConnection::connect(DaemonEndpoint::new(home.run_folder.clone()))
        .await
        .expect("the handshake completes");
    let status = connection
        .client()
        .call::<DaemonStatusRead>(&EmptyPayload {})
        .await
        .expect("the status read answers");
    connection.close().await;
    process
        .stop(DaemonStopIntent::Stop)
        .await
        .expect("the stop fails nothing");

    assert_eq!(
        refused["error"]["data"]["type"],
        RefusalCode::ConnectionHandshakeRequired.as_str(),
        "{refused}"
    );
    assert_eq!(status.process_state, DaemonProcessState::Running);
    assert_eq!(
        Path::new(status.data_directory.as_str()),
        home.data_folder()
    );
    assert!(!home.run_folder.socket_path.exists(), "the socket is gone");
    DataFolderLock::take(&home.data_folder()).expect("the stop let the data folder go");
}

// `daemon.stop` and `daemon.restart` each end the daemon for their own reason while another client
// is still connected, and the stop runs without waiting for that client; the write the caller had
// acknowledged is in the file afterwards. Killed by the restart asking for a stop, and by a stop
// that waits for every client to close.
#[rstest]
#[case::stop(DaemonStopIntent::Stop)]
#[case::restart(DaemonStopIntent::Restart)]
#[tokio::test(flavor = "multi_thread")]
async fn a_lifecycle_verb_ends_the_daemon_for_its_reason_with_another_client_connected(
    #[case] intent: DaemonStopIntent,
) {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let home = TestHome::new();
    let mut process = home
        .start(CancellationToken::new())
        .await
        .expect("the daemon starts");
    let endpoint = DaemonEndpoint::new(home.run_folder.clone());
    let caller = DaemonConnection::connect(endpoint.clone())
        .await
        .expect("the caller connects");
    let other = DaemonConnection::connect(endpoint)
        .await
        .expect("the other client connects");
    caller
        .client()
        .call::<DaemonConfigUpdate>(&DaemonConfigUpdateRequest::RecordTraces(true))
        .await
        .expect("the write is acknowledged");

    match intent {
        DaemonStopIntent::Stop => caller.client().call::<DaemonStop>(&EmptyPayload {}).await,
        DaemonStopIntent::Restart => {
            caller
                .client()
                .call::<DaemonRestart>(&EmptyPayload {})
                .await
        }
    }
    .expect("the verb is accepted");
    let asked = tokio::time::timeout(STOP_WAIT, process.wait_for_stop())
        .await
        .expect("the verb reaches the process");
    tokio::time::timeout(STOP_WAIT, process.stop(asked))
        .await
        .expect("the stop does not wait for the other client")
        .expect("the stop fails nothing");

    assert_eq!(asked, intent);
    let is_recording_traces: bool =
        Connection::open(home.data_folder().join(DAEMON_DATABASE_FILE_NAME))
            .expect("the file opens")
            .query_row(
                "SELECT record_traces FROM daemon_configuration WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .expect("the setting reads");
    assert!(is_recording_traces, "the acknowledged write is in the file");
    drop(other);
}

// A store another build made fails the start as another version's saved sessions, and the start
// leaves its file byte for byte as it found it. Killed by the open taking that refusal for any
// other failure of the writer's open.
#[tokio::test(flavor = "multi_thread")]
async fn a_store_of_another_build_fails_the_start_and_is_left_as_it_was() {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let home = TestHome::new();
    create_missing_private_folders(&home.data_folder()).expect("the data folder is made");
    let database_path = home.data_folder().join(DAEMON_DATABASE_FILE_NAME);
    let schema = schema_parts().into_schema();
    open_database(&database_path, &schema)
        .expect("the store opens")
        .pragma_update(None, "user_version", schema.fingerprint() ^ 1)
        .expect("the store takes another build's fingerprint");
    let before = std::fs::read(&database_path).expect("the store reads");

    let failure = home
        .start(CancellationToken::new())
        .await
        .err()
        .expect("the start fails");

    assert!(
        matches!(
            failure.failures.original(),
            DaemonStartError::DatabaseFile(DatabaseFileOpenError::SavedSessionsFromAnotherVersion {
                path,
            }) if *path == database_path
        ),
        "{:?}",
        failure.failures
    );
    assert_eq!(
        std::fs::read(&database_path).expect("the store reads"),
        before,
        "the store is as it was"
    );
}

// A start with terminal reach on, its Settings row's default, over a terminal service a former
// daemon kept on the person's own Codex folder joins that service before anything else reaches for
// the folder: no service of the daemon's own is launched, and the capability refresh reads from the
// kept one, on a connection of its own after the join's. Killed by the refresh run before the
// stored rows, which launches a service of the daemon's own on the folder first and probes it.
#[tokio::test(flavor = "multi_thread")]
async fn a_start_joins_the_kept_terminal_service_before_its_capability_refresh() {
    let Some(kept) = keep_terminal_service() else {
        return;
    };
    let home = TestHome::new().with_provider_environment(kept.provider_environment());

    let process = home
        .start(CancellationToken::new())
        .await
        .expect("the daemon starts");
    let connections = kept.connections();
    process
        .stop(DaemonStopIntent::Stop)
        .await
        .expect("the stop fails nothing");

    assert_eq!(kept.launch_arguments(), Vec::<String>::new());
    let is_probed_after_the_join = connections
        .iter()
        .skip(1)
        .any(|methods| methods.iter().any(|method| method != "initialize"));
    assert!(is_probed_after_the_join, "{connections:?}");
}
