use std::collections::HashSet;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt as _, StreamExt as _};
use interprocess::local_socket::tokio::Listener;
use interprocess::local_socket::traits::tokio::Listener as _;
use serde_json::{Value, json};
use sidekicks_platforms::{
    CAN_LINK_A_SOCKET, CAN_SIGNAL_A_STOP, LeftoverSweep, POSIX_SHELL, ProcessRecord, Spawner,
    connect_unix_domain_socket, create_file_atomically, harness_test_name, pin_child_process,
    read_socket_link, replace_socket_link, shell_line_command,
};
use tokio::io::AsyncReadExt as _;
use tokio::sync::mpsc;
use tokio::time::{Instant, timeout};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
use tokio_tungstenite::tungstenite::http::{HeaderValue, header};
use tokio_util::sync::CancellationToken;

use super::kept_records::{
    KeptServicesStop, lock_record, retire_former_service, stop_kept_services,
};
use super::{
    StartFailure, StartedService, compose_launch, launch_lasting_service, name_lasting_log_file,
    start_codex_service,
};
use crate::driver::child_records::UnrecordedChildren;
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome, CodexServiceKind};
use crate::driver::codex::service::process::{
    CodexProcessLaunch, repin_lasting_codex_service, start_lasting_codex_service,
};
use crate::driver::codex::service::record::{LastingServiceRecord, LastingServiceRecordFile};
use crate::driver::codex::service::registry::live_record_files;
use crate::driver::codex::service::supervisor::own_record::socket_record_file;
use crate::driver::codex::service::supervisor::test_service::{
    STAND_IN_CODEX, StandInReplies, TestCodexProgram, UnheardEvents, answer_as_codex_service,
    bind_test_listener, next_socket_request, send_on_socket, test_codex_service_dependencies,
    write_failing_codex,
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
        .write(&LastingServiceRecord::launched(
            record.clone(),
            socket.clone(),
        ))
        .expect("the record is written");
    let is_pinned = repin_lasting_codex_service(record.clone())
        .expect("the record re-pins")
        .is_some();

    let retired = retire_former_service(
        &locked,
        LastingServiceRecord::launched(record, socket.clone()),
    )
    .await;
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
            tokio::spawn(answer_as_codex_service(
                stream,
                StandInReplies::default(),
                |_request| {},
            ));
        }
    });

    let started = start_terminal_service_on(folder.path(), &socket).await;

    let Ok(Ok(started)) = started else {
        panic!("the start did not join the listener");
    };
    assert_eq!(started.kind, CodexServiceKind::Joined);
}

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
    stop_kept_services(
        service.dependencies().data_folder.clone(),
        KeptServicesStop::DaemonStop {
            deadline: Instant::now() + Duration::from_secs(60),
        },
        HashSet::new(),
    )
    .await;

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

// Fails when the erase's end of a recorded service that is gone leaves the home's link naming the
// socket the service really listened on, so a plain `codex` meets a link to a dead socket.
#[tokio::test]
async fn an_erase_takes_the_home_link_off_a_gone_service_s_socket() {
    if !CAN_LINK_A_SOCKET {
        return;
    }
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let home_socket = folder.path().join("home.sock");
    let physical_socket = folder.path().join("own.sock");
    replace_socket_link(&home_socket, &physical_socket).expect("the home's link is made");
    // This test's own process with another start mark, as a record whose process ended reads.
    let own = pin_child_process(std::process::id())
        .expect("this process pins")
        .record()
        .expect("the record reads")
        .expect("this process runs");
    let mut gone = serde_json::to_value(own).expect("a process record writes as JSON");
    gone["start"] = (gone["start"].as_u64().expect("the start mark is a number") + 1).into();
    let gone: ProcessRecord = serde_json::from_value(gone).expect("the changed record reads");
    LastingServiceRecordFile::of_socket(folder.path(), folder.path(), &physical_socket)
        .expect("the record file is named")
        .lock()
        .expect("the records lock")
        .write(&LastingServiceRecord {
            physical_socket: Some(physical_socket.clone()),
            ..LastingServiceRecord::launched(gone, home_socket.clone())
        })
        .expect("the record is written");

    let failures = stop_kept_services(
        folder.path().to_owned(),
        KeptServicesStop::Erase,
        HashSet::new(),
    )
    .await;

    assert!(failures.is_empty(), "{failures:?}");
    assert_eq!(
        read_socket_link(&home_socket).expect("the link reads"),
        None
    );
}

// Killed by the daemon's stop giving a kept service its full grace in place of what is left of the
// stop: the top cap returns at the deadline, but a service ignoring its stop then runs on past it.
#[tokio::test]
async fn a_daemon_stop_ends_a_kept_service_that_ignores_its_stop_by_the_deadline() {
    if !CAN_SIGNAL_A_STOP {
        return;
    }
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let (mut child, _record_file) = recorded_stand_in(
        folder.path(),
        "trap '' TERM; echo; exec sleep 60",
        "codex.sock",
    )
    .await;
    let deadline = Instant::now() + Duration::from_millis(300);

    let stopped = timeout(
        Duration::from_millis(1300),
        stop_kept_services(
            folder.path().to_owned(),
            KeptServicesStop::DaemonStop { deadline },
            HashSet::new(),
        ),
    )
    .await;
    let ended = timeout(Duration::from_secs(1), child.wait()).await;

    assert!(stopped.is_ok(), "the stop ran past its deadline");
    let status = ended
        .expect("the stand-in still runs a second after the stop")
        .expect("the stand-in's end reads");
    assert!(status.code().is_none(), "{status:?}");
}

// Fails when the daemon's stop of the records kept also stops a service of its own, which that
// service's supervisor stops beside it, or leaves a former daemon's service in the same Codex
// folder running. Killed by dropping the skip of the live records.
#[tokio::test]
async fn a_daemon_stop_of_kept_records_leaves_a_live_service_s_record_to_its_supervisor() {
    if !CAN_SIGNAL_A_STOP {
        return;
    }
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let (mut live, live_record) =
        recorded_stand_in(folder.path(), "echo; exec sleep 60", "live.sock").await;
    let (mut former, former_record) =
        recorded_stand_in(folder.path(), "echo; exec sleep 60", "former.sock").await;

    let failures = stop_kept_services(
        folder.path().to_owned(),
        KeptServicesStop::DaemonStop {
            deadline: Instant::now() + Duration::from_secs(5),
        },
        HashSet::from([live_record.clone()]),
    )
    .await;
    let former_end = timeout(Duration::from_secs(5), former.wait()).await;
    let live_exit = live.try_wait().expect("the live stand-in's state reads");
    let read_record = |file: &LastingServiceRecordFile| {
        file.lock()
            .and_then(|locked| locked.read())
            .expect("the record reads")
    };

    assert!(failures.is_empty(), "{failures:?}");
    assert!(
        former_end.is_ok(),
        "the former daemon's service still runs after the stop"
    );
    assert_eq!(read_record(&former_record), None);
    assert!(
        live_exit.is_none(),
        "the kept stop ended a live service: {live_exit:?}"
    );
    assert!(
        read_record(&live_record).is_some(),
        "the kept stop removed a live service's record"
    );
}

// Fails when a launch on a socket of its own beside the home's, as a terminal service launches
// beside a draining one, is in flight at a daemon stop and the kept stop ends it and removes its
// record beside the start's own teardown, or when the failed launch leaves its record named the
// service's in place of the home socket's. Killed by dropping the launch's publish of its record
// file before it writes the record, and by dropping the failure's restore of the name before it.
#[tokio::test(flavor = "multi_thread")]
async fn a_daemon_stop_leaves_a_launch_beside_under_way_to_its_supervisor() {
    if !CAN_SIGNAL_A_STOP {
        return;
    }
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let home_socket = folder.path().join("home.sock");
    let own_socket = folder.path().join("own.sock");
    // Held unanswered, so the launch is under way once its dial is accepted.
    let Some(listener) = bind_test_listener(&own_socket) else {
        return;
    };
    let program = folder.path().join("codex");
    create_file_atomically(
        &program,
        STAND_IN_CODEX.as_bytes(),
        0o755,
        LeftoverSweep::Unswept,
    )
    .expect("the stand-in is written");
    let dependencies = test_codex_service_dependencies(
        folder.path(),
        Arc::new(TestCodexProgram {
            program,
            environment: vec![("PATH".to_owned(), "/usr/bin:/bin".to_owned())],
        }),
        Arc::new(UnheardEvents),
        Arc::new(UnrecordedChildren),
    );
    let data_folder = dependencies.data_folder.clone();
    let codex_home = dependencies.personal_home.clone();
    std::fs::create_dir(&codex_home).expect("the person's folder is made");
    let service = CodexService::new(
        CodexServiceHome {
            codex_home: codex_home.clone(),
            kind: CodexHomeKind::PersonalFolder,
        },
        CodexServiceSocket {
            path: home_socket.clone(),
            home_socket,
        },
        CodexServiceKind::Terminal,
        Arc::clone(&dependencies),
        Vec::new(),
    );
    let executable = dependencies
        .program
        .resolve(service.home())
        .await
        .expect("the test program resolves");
    let Ok(process_launch) = compose_launch(
        &service,
        &executable,
        service.launch_config_overrides(),
        &own_socket,
    )
    .await
    else {
        panic!("the launch was not composed");
    };
    let log_file = name_lasting_log_file(&service)
        .unwrap_or_else(|failure| panic!("the log is named: {:?}", failure.error));
    let beside_record = LastingServiceRecordFile::of_socket(&data_folder, &codex_home, &own_socket)
        .expect("the record file is named");
    // The home socket's record, which a former start of the service named its own.
    let home_record = socket_record_file(&service).expect("the home's record file is named");
    service.set_process_record_file(Some(home_record.clone()));
    let locked = lock_record(beside_record.clone())
        .await
        .unwrap_or_else(|failure| panic!("the record locks: {:?}", failure.error));
    let cancel = CancellationToken::new();
    let launching = tokio::spawn({
        let (service, locked, cancel) = (Arc::clone(&service), Arc::clone(&locked), cancel.clone());
        async move {
            launch_lasting_service(
                &service,
                1,
                &cancel,
                process_launch,
                &log_file,
                &locked,
                &own_socket,
            )
            .await
        }
    });
    let held = timeout(Duration::from_secs(10), listener.accept())
        .await
        .expect("the launch dials within its wait")
        .expect("the dial is accepted");

    let live_records = live_record_files(&[Arc::clone(&service)]);
    drop((held, listener));
    cancel.cancel();
    let launched = timeout(Duration::from_secs(10), launching)
        .await
        .expect("the stood-down launch ends")
        .expect("the launch's task ends");
    // The failure hands back the launched process for a teardown this test leaves undone.
    let Err(_failure) = launched else {
        panic!("the launch answered on a socket held unanswered");
    };
    let named = service.process_record_file();
    drop(locked);
    let failures = stop_kept_services(
        data_folder.clone(),
        KeptServicesStop::DaemonStop {
            deadline: Instant::now() + Duration::from_secs(5),
        },
        live_records,
    )
    .await;
    let kept = beside_record
        .lock()
        .and_then(|locked| locked.read())
        .expect("the record reads");
    let is_running = kept.as_ref().is_some_and(|record| {
        repin_lasting_codex_service(record.process.clone())
            .expect("the process table reads")
            .is_some()
    });
    // Ends the stand-in, which outlives this test otherwise, before any assertion can fail.
    stop_kept_services(
        data_folder,
        KeptServicesStop::DaemonStop {
            deadline: Instant::now() + Duration::from_secs(5),
        },
        HashSet::new(),
    )
    .await;

    assert!(failures.is_empty(), "{failures:?}");
    assert!(
        kept.is_some(),
        "the kept stop removed a launch's record under way"
    );
    assert!(is_running, "the kept stop ended a launch under way");
    assert_eq!(
        named,
        Some(home_record),
        "a failed launch left its record named the service's"
    );
}

// A shell stand-in running `script`, which writes one byte once it is ready, recorded as the
// lasting service on `socket_name` of the Codex folder `folder`, in `folder` as the data folder;
// ended when the answered child drops.
async fn recorded_stand_in(
    folder: &Path,
    script: &str,
    socket_name: &str,
) -> (tokio::process::Child, LastingServiceRecordFile) {
    let mut child = shell_line_command(Path::new(POSIX_SHELL), script)
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("the stand-in starts");
    // Its first byte says the script's set-up ran, so a stop's signal cannot race it.
    let mut ready = [0_u8];
    child
        .stdout
        .take()
        .expect("the stand-in's output is piped")
        .read_exact(&mut ready)
        .await
        .expect("the stand-in is ready");
    let process = pin_child_process(child.id().expect("the stand-in runs"))
        .expect("the stand-in pins")
        .record()
        .expect("the record reads")
        .expect("the stand-in runs");
    let socket = folder.join(socket_name);
    let record_file = LastingServiceRecordFile::of_socket(folder, folder, &socket)
        .expect("the record file is named");
    record_file
        .lock()
        .expect("the records lock")
        .write(&LastingServiceRecord::launched(process, socket))
        .expect("the record is written");
    (child, record_file)
}

// Killed by any service's launch left without the person's privacy choices, the capability read's
// on the daemon's own empty home among them, or carrying them before the switches the daemon sets,
// where an earlier switch loses.
#[tokio::test]
async fn every_launch_carries_the_person_s_privacy_choices_last() {
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let dependencies = test_codex_service_dependencies(
        folder.path(),
        Arc::new(TestCodexProgram {
            program: write_failing_codex(folder.path()),
            environment: Vec::new(),
        }),
        Arc::new(UnheardEvents),
        Arc::new(UnrecordedChildren),
    );
    let personal_home = dependencies.personal_home.clone();
    std::fs::create_dir(&personal_home).expect("the person's folder is made");
    std::fs::write(
        personal_home.join("config.toml"),
        "[analytics]\nenabled = false\n\n[feedback]\nenabled = false\n",
    )
    .expect("the person's configuration is written");
    let socket = folder.path().join("s.sock");
    let homes = [
        (
            CodexServiceHome {
                codex_home: folder.path().join("account"),
                kind: CodexHomeKind::Account(test_provider_account_id()),
            },
            CodexServiceKind::Account,
        ),
        (
            CodexServiceHome {
                codex_home: folder.path().join("capability-read"),
                kind: CodexHomeKind::CapabilityRead,
            },
            CodexServiceKind::Account,
        ),
        (
            CodexServiceHome {
                codex_home: personal_home,
                kind: CodexHomeKind::PersonalFolder,
            },
            CodexServiceKind::Terminal,
        ),
    ];

    let mut launched = Vec::new();
    for (home, kind) in homes {
        let service = CodexService::new(
            home,
            CodexServiceSocket {
                path: socket.clone(),
                home_socket: socket.clone(),
            },
            kind,
            Arc::clone(&dependencies),
            vec!["service.own=1".to_owned()],
        );
        let executable = dependencies
            .program
            .resolve(service.home())
            .await
            .expect("the test program resolves");
        let Ok(launch) = compose_launch(
            &service,
            &executable,
            service.launch_config_overrides(),
            &socket,
        )
        .await
        else {
            panic!("the launch was not composed");
        };
        launched.push(launch.arguments);
    }

    assert_eq!(launched.len(), 3);
    for arguments in &launched {
        assert!(
            arguments.ends_with(&[
                "-c".to_owned(),
                "service.own=1".to_owned(),
                "-c".to_owned(),
                "analytics.enabled=false".to_owned(),
                "-c".to_owned(),
                "feedback.enabled=false".to_owned(),
            ]),
            "{arguments:?}"
        );
    }
}
