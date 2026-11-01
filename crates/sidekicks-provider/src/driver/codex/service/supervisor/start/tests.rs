use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt as _, StreamExt as _};
use interprocess::local_socket::tokio::Listener;
use interprocess::local_socket::traits::tokio::Listener as _;
use serde_json::{Value, json};
use sidekicks_platforms::{
    LeftoverSweep, Spawner, connect_unix_domain_socket, create_file_atomically, harness_test_name,
};
use tokio::io::AsyncReadExt as _;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
use tokio_tungstenite::tungstenite::http::{HeaderValue, header};
use tokio_util::sync::CancellationToken;

use super::kept_records::{retire_former_service, stop_kept_services};
use super::{StartFailure, StartedService, start_codex_service};
use crate::driver::child_records::UnrecordedChildren;
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome, CodexServiceKind};
use crate::driver::codex::service::process::{
    CodexProcessLaunch, repin_lasting_codex_service, start_lasting_codex_service,
};
use crate::driver::codex::service::record::{LastingServiceRecord, LastingServiceRecordFile};
use crate::driver::codex::service::supervisor::test_service::{
    TestCodexProgram, UnheardEvents, answer_as_codex_service, bind_test_listener,
    next_socket_request, send_on_socket, test_codex_service_dependencies, write_failing_codex,
};
use crate::driver::codex::service::supervisor::{CodexService, CodexServiceSocket};
use crate::driver::codex::session::errors::CodexError;
use crate::runtime_binding::test_store::test_provider_account_id;

/// The survivor's stand-in: this test program, which holds a connection to the test's socket open
/// while it runs, so its end closes it.
const SURVIVOR_STAND_IN: &str = "a_survivor_that_waits";

/// The root's stand-in: this test program, which starts the survivor and ends at once.
const ROOT_STAND_IN: &str = "a_root_that_leaves_its_survivor";

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

// Skips unless the retire test started it. Leaves the survivor running past its own end, as a
// root whose helper outlived it.
#[tokio::test]
#[ignore = "run only as the retire test's root"]
async fn a_root_that_leaves_its_survivor() {
    if std::env::var_os(SURVIVOR_SOCKET_NAME).is_none() {
        return;
    }
    tokio::process::Command::new(std::env::current_exe().expect("the test program names itself"))
        .args(stand_in_arguments(SURVIVOR_STAND_IN))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("the survivor starts");
}

// The arguments that run this test program as the stand-in test `name` alone.
fn stand_in_arguments(name: &str) -> Vec<String> {
    vec![
        "--exact".to_owned(),
        harness_test_name(module_path!(), name),
        "--include-ignored".to_owned(),
    ]
}

// Starts a terminal service on `socket` as the home's own socket, under `folder`, whose Codex
// command fails at once, and answers its start.
async fn start_terminal_service_on(
    folder: &Path,
    socket: &Path,
) -> Result<Result<StartedService, StartFailure>, tokio::time::error::Elapsed> {
    let codex_home = folder.join("home");
    std::fs::create_dir(&codex_home).expect("the home is made");
    let dependencies = test_codex_service_dependencies(
        folder,
        Arc::new(TestCodexProgram {
            program: write_failing_codex(folder),
            environment: Vec::new(),
        }),
        Arc::new(UnheardEvents),
        Arc::new(UnrecordedChildren),
    );
    let deadline = dependencies.startup_timeout;
    let service = CodexService::new(
        CodexServiceHome {
            codex_home,
            kind: CodexHomeKind::PersonalFolder,
        },
        CodexServiceSocket {
            path: socket.to_owned(),
            home_socket: socket.to_owned(),
        },
        CodexServiceKind::Terminal,
        dependencies,
        Vec::new(),
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
    let launch = CodexProcessLaunch {
        program: std::env::current_exe().expect("the test program names itself"),
        arguments: stand_in_arguments(ROOT_STAND_IN),
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

    let started = start_terminal_service_on(folder.path(), &socket).await;

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
            tokio::spawn(answer_as_codex_service(stream, None, |_request| {}));
        }
    });

    let started = start_terminal_service_on(folder.path(), &socket).await;

    let Ok(Ok(started)) = started else {
        panic!("the start did not join the listener");
    };
    assert_eq!(started.kind, CodexServiceKind::Joined);
}

// A Codex stand-in: as the executor it answers the relay's `initialize` and waits on its input; as
// the service it waits, the test's listener answering in its place.
const STAND_IN_CODEX: &str = r#"#!/bin/sh
case " $* " in
  *" exec-server "*)
    IFS= read -r _initialize
    printf '%s\n' '{"id":"sidekicks-relay-1","result":{}}'
    exec cat >/dev/null
    ;;
esac
exec sleep 30
"#;

// Answers each connection on `listener` as a Codex service and hands every request on to
// `requests`, in the order it came.
async fn answer_and_record(listener: Listener, requests: mpsc::UnboundedSender<Value>) {
    while let Ok(stream) = listener.accept().await {
        let requests = requests.clone();
        tokio::spawn(async move {
            let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
                return;
            };
            loop {
                let request = next_socket_request(&mut socket).await;
                let result = match request["method"].as_str() {
                    Some("initialize") => {
                        json!({"userAgent": "ai-sidekicks-daemon/0.130.0 (test)"})
                    }
                    _ => json!({}),
                };
                let reply = json!({"id": request["id"], "result": result});
                // Recorded before the answer, so the start never answers ahead of its record.
                if requests.send(request).is_err() {
                    return;
                }
                send_on_socket(&mut socket, reply).await;
            }
        });
    }
}

// Fails when an account's start answers before the relay's environment is added on its
// connection, which lets a resume come first, or when a restart keeps the earlier start's token.
#[tokio::test(flavor = "multi_thread")]
async fn an_account_start_adds_the_relay_environment_before_it_answers() {
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let socket = folder.path().join("s.sock");
    let Some(listener) = bind_test_listener(&socket) else {
        return;
    };
    let (requests, mut recorded) = mpsc::unbounded_channel();
    tokio::spawn(answer_and_record(listener, requests));
    let program = folder.path().join("codex");
    create_file_atomically(
        &program,
        STAND_IN_CODEX.as_bytes(),
        0o755,
        LeftoverSweep::Unswept,
    )
    .expect("the stand-in is written");
    let codex_home = folder.path().join("home");
    std::fs::create_dir(&codex_home).expect("the home is made");
    let dependencies = test_codex_service_dependencies(
        folder.path(),
        Arc::new(TestCodexProgram {
            program,
            environment: vec![("PATH".to_owned(), "/usr/bin:/bin".to_owned())],
        }),
        Arc::new(UnheardEvents),
        Arc::new(UnrecordedChildren),
    );
    let deadline = dependencies.startup_timeout;
    let service = CodexService::new(
        CodexServiceHome {
            codex_home,
            kind: CodexHomeKind::Account(test_provider_account_id()),
        },
        CodexServiceSocket {
            path: socket.clone(),
            home_socket: socket,
        },
        CodexServiceKind::Account,
        dependencies,
        Vec::new(),
    );

    let mut starts = Vec::new();
    for launch in [1, 2] {
        let started = tokio::time::timeout(
            deadline,
            start_codex_service(Arc::clone(&service), launch, CancellationToken::new(), None),
        )
        .await;
        let mut sent = Vec::new();
        while let Ok(request) = recorded.try_recv() {
            sent.push(request);
        }
        starts.push((started, sent));
    }
    // The stop a daemon stop makes ends the kept service, which outlives this test otherwise, so
    // it runs before any assertion can fail.
    stop_kept_services(service.dependencies().data_folder.clone()).await;

    let mut tokens = Vec::new();
    for (started, sent) in starts {
        let started = started.expect("the start ends within its deadline");
        assert!(
            started.is_ok(),
            "the start fails: {:?}",
            started.err().map(|failure| failure.error)
        );
        let added = sent.last().expect("the start sent its requests");
        assert_eq!(added["method"], "environment/add", "{sent:?}");
        assert_eq!(added["params"]["environmentId"], "sidekicks-relay");
        let url = added["params"]["execServerUrl"]
            .as_str()
            .expect("the relay's address");
        assert!(url.starts_with("ws://127.0.0.1:"), "{url}");
        let token = added["params"]["authBearerToken"]
            .as_str()
            .expect("the start's token")
            .to_owned();
        tokens.push((url.to_owned(), token));
    }

    let [(url, earlier), (_, current)] = tokens.as_slice() else {
        panic!("two starts");
    };
    assert_ne!(earlier, current);
    for (token, is_admitted) in [(earlier, false), (current, true)] {
        let mut request = url.as_str().into_client_request().expect("a request");
        request.headers_mut().insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).expect("a header value"),
        );
        assert_eq!(
            tokio_tungstenite::connect_async(request).await.is_ok(),
            is_admitted
        );
    }
}
