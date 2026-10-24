use std::io;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt as _, StreamExt as _};
use interprocess::local_socket::tokio::Listener;
use interprocess::local_socket::traits::tokio::Listener as _;
use serde_json::{Value, json};
use sidekicks_platforms::{
    ExistingSocket, Spawner, bind_socket_listener, connect_unix_domain_socket,
};
use tokio::io::AsyncReadExt as _;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

use super::kept_records::retire_former_service;
use super::{StartFailure, StartedService, start_codex_service};
use crate::provider::driver::codex::service::home::{
    CodexHomeKind, CodexServiceHome, CodexServiceKind,
};
use crate::provider::driver::codex::service::process::{
    CodexProcessLaunch, repin_lasting_codex_service, start_lasting_codex_service,
};
use crate::provider::driver::codex::service::record::{
    LastingServiceRecord, LastingServiceRecordFile,
};
use crate::provider::driver::codex::service::supervisor::test_service::{
    TestCodexProgram, UnheardEvents, answer_as_codex_service, test_codex_service_dependencies,
};
use crate::provider::driver::codex::service::supervisor::{CodexService, CodexServiceSocket};
use crate::provider::driver::codex::session::errors::CodexError;

/// The survivor's stand-in: this test program, which holds a connection to the test's socket open
/// while it runs, so its end closes it.
const SURVIVOR_STAND_IN: &str =
    "provider::driver::codex::service::supervisor::start::tests::a_survivor_that_waits";

/// Where the survivor connects, passed in its environment.
const SURVIVOR_SOCKET_NAME: &str = "SIDEKICKS_SURVIVOR_SOCKET";

/// How long the test waits on the survivor's start and on its end.
const SURVIVOR_WAIT: Duration = Duration::from_secs(10);

// Skips unless the retire test started it, so a run of every ignored test passes it by.
#[tokio::test]
#[ignore = "run only as the retire test's survivor"]
async fn a_survivor_that_waits() {
    let Ok(socket) = std::env::var(SURVIVOR_SOCKET_NAME) else {
        return;
    };
    let _connection = connect_unix_domain_socket(socket.as_ref())
        .await
        .expect("the survivor reaches the test");
    tokio::time::sleep(Duration::from_secs(60)).await;
}

// A listener at `socket`, or `None` where the system binds no local socket for a test.
fn bind_test_listener(socket: &Path) -> Option<Listener> {
    match bind_socket_listener(socket, ExistingSocket::Refuse) {
        Ok(listener) => Some(listener),
        Err(error) if error.kind() == io::ErrorKind::Unsupported => None,
        Err(error) => panic!("the test's socket does not listen: {error}"),
    }
}

// Starts a terminal service on `socket` as the home's own socket, under `folder`, whose Codex
// program is `program`, and answers its start.
async fn start_terminal_service_on(
    folder: &Path,
    socket: &Path,
    program: &str,
) -> Result<Result<StartedService, StartFailure>, tokio::time::error::Elapsed> {
    let codex_home = folder.join("home");
    std::fs::create_dir(&codex_home).expect("the home is made");
    let dependencies = test_codex_service_dependencies(
        folder,
        Arc::new(TestCodexProgram {
            program: program.into(),
            environment: Vec::new(),
        }),
        Arc::new(UnheardEvents),
    );
    let deadline = dependencies.startup_timeout;
    let service = CodexService::new(
        CodexServiceHome {
            codex_home,
            provider_account_id: None,
            kind: CodexHomeKind::PersonalFolder {
                is_terminal_reach_on: true,
            },
        },
        CodexServiceSocket {
            path: socket.to_owned(),
            home_socket: socket.to_owned(),
        },
        CodexServiceKind::Terminal,
        dependencies,
    );
    tokio::time::timeout(
        deadline,
        start_codex_service(service, 1, CancellationToken::new(), None),
    )
    .await
}

// Fails when a former service whose record no longer pins it is let go without ending the tree
// it left, here a helper that outlived its root, or with its record still kept.
#[tokio::test(flavor = "multi_thread")]
async fn a_former_service_its_record_no_longer_pins_leaves_no_tree_running() {
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let socket = folder.path().join("survivor.sock");
    let Some(listener) = bind_test_listener(&socket) else {
        return;
    };
    let program = std::env::current_exe().expect("the test program names itself");
    let launch = CodexProcessLaunch {
        program: "/bin/sh".into(),
        arguments: vec![
            "-c".to_owned(),
            format!("\"$0\" --exact {SURVIVOR_STAND_IN} --include-ignored >/dev/null 2>&1 &"),
            program.display().to_string(),
        ],
        environment: vec![(
            SURVIVOR_SOCKET_NAME.to_owned(),
            socket.display().to_string(),
        )],
        working_folder: folder.path().to_owned(),
    };
    let spawner = Spawner::new(tokio::runtime::Handle::current()).expect("the spawner starts");
    let service = start_lasting_codex_service(&spawner, launch, &folder.path().join("codex.log"))
        .await
        .expect("the root starts");
    let mut survivor = tokio::time::timeout(SURVIVOR_WAIT, listener.accept())
        .await
        .expect("the survivor starts in time")
        .expect("the survivor connects");
    service
        .exited()
        .expect("the root is this test's child")
        .await
        .expect("the root's exit reads");
    let record = service.record().clone();
    let record_file = LastingServiceRecordFile::of_socket(folder.path(), folder.path(), &socket)
        .expect("the record file is named");
    let locked = Arc::new(record_file.lock().expect("the record is locked"));
    locked
        .write(&LastingServiceRecord::launched(record.clone()))
        .expect("the record is written");
    let is_pinned = repin_lasting_codex_service(record.clone())
        .expect("the record re-pins")
        .is_some();

    let retired = retire_former_service(&locked, record).await;
    let mut rest = Vec::new();
    let survivor_end = tokio::time::timeout(SURVIVOR_WAIT, survivor.read_to_end(&mut rest)).await;
    let kept = locked.read().expect("the record reads");

    assert!(!is_pinned);
    assert!(retired.is_ok());
    assert!(
        matches!(survivor_end, Ok(Ok(0))),
        "the survivor still runs: {survivor_end:?}"
    );
    assert_eq!(kept, None);
}

// Answers every `initialize` on `listener` with an error, as a service that refuses the daemon.
async fn refuse_every_initialize(listener: Listener) {
    while let Ok(stream) = listener.accept().await {
        tokio::spawn(async move {
            // A probe that only connects ends before the upgrade.
            let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
                return;
            };
            while let Some(Ok(message)) = socket.next().await {
                let Message::Text(text) = message else {
                    continue;
                };
                let request: Value = serde_json::from_str(&text).expect("the daemon sends JSON");
                if request["method"] == "initialize" {
                    let refusal = json!({"id": request["id"],
                        "error": {"code": -32600, "message": "not this client"}});
                    let _sent = socket.send(Message::Text(refusal.to_string().into())).await;
                }
            }
        });
    }
}

// Fails when a start that finds a listener refusing its `initialize` tries again rather than
// reporting the refusal, which spins until its deadline or, without one, past every stop.
#[tokio::test(flavor = "multi_thread")]
async fn a_start_on_a_listener_that_refuses_it_reports_the_refusal_within_its_deadline() {
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let socket = folder.path().join("s.sock");
    let Some(listener) = bind_test_listener(&socket) else {
        return;
    };
    tokio::spawn(refuse_every_initialize(listener));

    let started = start_terminal_service_on(folder.path(), &socket, "/usr/bin/false").await;

    let Ok(Err(failure)) = started else {
        panic!("the start did not fail within its deadline");
    };
    let is_initialize_refused = matches!(
        &failure.error,
        CodexError::ProviderRequest { method, .. } if method == "initialize"
    );
    assert!(is_initialize_refused, "{:?}", failure.error);
}

// Fails when a start that finds a free listener no pid file names stops or replaces it instead of
// joining it, which refuses the start with the socket in use.
#[tokio::test(flavor = "multi_thread")]
async fn a_start_on_a_free_listener_no_pid_file_names_joins_it() {
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let socket = folder.path().join("s.sock");
    let Some(listener) = bind_test_listener(&socket) else {
        return;
    };
    tokio::spawn(async move {
        while let Ok(stream) = listener.accept().await {
            tokio::spawn(answer_as_codex_service(stream));
        }
    });

    let started = start_terminal_service_on(folder.path(), &socket, "/usr/bin/false").await;

    let Ok(Ok(started)) = started else {
        panic!("the start did not join the listener");
    };
    assert_eq!(started.kind, CodexServiceKind::Joined);
}
