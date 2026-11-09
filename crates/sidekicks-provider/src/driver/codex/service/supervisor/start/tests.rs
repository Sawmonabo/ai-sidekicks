mod kept_stop;

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt as _, StreamExt as _};
use interprocess::local_socket::tokio::Listener;
use interprocess::local_socket::traits::tokio::Listener as _;
use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_platforms::{
    LeftoverSweep, Spawner, connect_unix_domain_socket, create_file_atomically, harness_test_name,
};
use tokio::io::AsyncReadExt as _;
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
use tokio_tungstenite::tungstenite::http::{HeaderValue, header};
use tokio_util::sync::CancellationToken;

use super::kept_records::retire_former_service;
use super::kept_records::stop::{KeptServicesStop, stop_kept_services};
use super::{StartFailure, StartedService, compose_launch, start_codex_service};
use crate::driver::child_records::UnrecordedChildren;
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::exec_relay::compose_codex_executor_arguments;
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome, CodexServiceKind};
use crate::driver::codex::service::process::{
    CodexProcessLaunch, repin_lasting_codex_service, start_lasting_codex_service,
};
use crate::driver::codex::service::record::{LastingServiceRecord, LastingServiceRecordFile};
use crate::driver::codex::service::registry::home_exec_switches;
use crate::driver::codex::service::supervisor::test_service::{
    STAND_IN_CODEX, StandInReplies, TestCodexProgram, UnheardEvents, answer_as_codex_service,
    bind_test_listener, next_socket_request, send_on_socket, test_codex_service_dependencies,
    write_failing_codex,
};
use crate::driver::codex::service::supervisor::{CodexService, CodexServiceSocket};
use crate::driver::codex::session::errors::CodexError;
use crate::pricing::receiver::TelemetryTarget;
use crate::pricing::receiver::bearers::{TelemetryBearers, TelemetryHolderId};
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
    let service =
        start_lasting_codex_service(&spawner, launch, None, &folder.path().join("codex.log"))
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
            None,
        ))
        .expect("the record is written");
    let is_pinned = repin_lasting_codex_service(record.clone())
        .expect("the record re-pins")
        .is_some();

    let retired = retire_former_service(
        &locked,
        LastingServiceRecord::launched(record, socket.clone(), None),
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
        &[],
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
        let Ok((launch, _bearer)) = compose_launch(
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

/// What a case's launch carries for telemetry: the daemon's log export with its token, every
/// exporter off, or the person's own settings alone.
enum LaunchTelemetry {
    DaemonExport,
    ExportersOff,
    PersonsOwn,
}

/// Every exporter off, as a command line carries them.
const EXPORTERS_OFF: [&str; 3] = [
    "otel.exporter=\"none\"",
    "otel.trace_exporter=\"none\"",
    "otel.metrics_exporter=\"none\"",
];

// Killed by the daemon's switches or its bearer on any home they do not belong to, the person's
// folder's terminal service among them; by an exporter left on for a read service, for a short
// command on a home of the daemon's own, or for a launch before the target is registered; by an
// executor started with any exporter left on; by `statsig` or any metrics exporter left on a read
// or a short command; by the bearer on the command line; by a header value the receiver's token
// refuses; and by a launch exporting with no tag, and a tag on a launch that exports nowhere.
#[rstest]
#[case::an_account_service(
    CodexHomeKind::Account(test_provider_account_id()),
    CodexServiceKind::Account,
    true,
    LaunchTelemetry::DaemonExport
)]
#[case::an_account_service_before_the_target(
    CodexHomeKind::Account(test_provider_account_id()),
    CodexServiceKind::Account,
    false,
    LaunchTelemetry::ExportersOff
)]
#[case::the_capability_read(
    CodexHomeKind::CapabilityRead,
    CodexServiceKind::Account,
    true,
    LaunchTelemetry::ExportersOff
)]
#[case::a_transient_read_on_the_person_s_folder(
    CodexHomeKind::PersonalFolder,
    CodexServiceKind::Account,
    true,
    LaunchTelemetry::ExportersOff
)]
#[case::the_terminal_service(
    CodexHomeKind::PersonalFolder,
    CodexServiceKind::Terminal,
    true,
    LaunchTelemetry::PersonsOwn
)]
#[tokio::test]
async fn a_launch_carries_its_home_s_telemetry_switches(
    #[case] home_kind: CodexHomeKind,
    #[case] service_kind: CodexServiceKind,
    #[case] is_registered: bool,
    #[case] expected: LaunchTelemetry,
) {
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let persons_headers = (
        "OTEL_EXPORTER_OTLP_HEADERS".to_owned(),
        "authorization=person".to_owned(),
    );
    let dependencies = test_codex_service_dependencies(
        folder.path(),
        Arc::new(TestCodexProgram {
            program: write_failing_codex(folder.path()),
            environment: vec![persons_headers.clone()],
        }),
        Arc::new(UnheardEvents),
        Arc::new(UnrecordedChildren),
    );
    let bearers = Arc::new(TelemetryBearers::default());
    let target = Arc::new(TelemetryTarget::new(4318, Arc::clone(&bearers)));
    if is_registered {
        dependencies
            .telemetry_target
            .register(Arc::clone(&target))
            .expect("the target registers once");
    }
    let socket = folder.path().join("s.sock");
    let service = CodexService::new(
        CodexServiceHome {
            codex_home: folder.path().join("home"),
            kind: home_kind.clone(),
        },
        CodexServiceSocket {
            path: socket.clone(),
            home_socket: socket.clone(),
        },
        service_kind,
        Arc::clone(&dependencies),
        Vec::new(),
    );
    let executable = dependencies
        .program
        .resolve(service.home())
        .await
        .expect("the test program resolves");
    // The launch's own token stays live while its guard is held here.
    let Ok((launch, _bearer)) = compose_launch(
        &service,
        &executable,
        service.launch_config_overrides(),
        &socket,
    )
    .await
    else {
        panic!("the launch was not composed");
    };

    let switches: Vec<&str> = launch
        .arguments
        .iter()
        .map(String::as_str)
        .filter(|argument| argument.starts_with("otel."))
        .collect();
    let headers = launch
        .environment
        .iter()
        .find(|(name, _)| name == "OTEL_EXPORTER_OTLP_LOGS_HEADERS");
    let tag = launch
        .environment
        .iter()
        .find(|(name, _)| name == "OTEL_RESOURCE_ATTRIBUTES");
    match expected {
        LaunchTelemetry::DaemonExport => {
            let exporter = switches[0]
                .strip_prefix("otel.exporter=")
                .expect("the exporter leads");
            let read: toml::Table =
                toml::from_str(&format!("value = {exporter}")).expect("the value is TOML");
            assert_eq!(
                serde_json::to_value(&read["value"]).expect("a TOML value is JSON"),
                json!({"otlp-http": {
                    "endpoint": "http://127.0.0.1:4318/telemetry/codex/v1/logs",
                    "protocol": "binary",
                }})
            );
            assert_eq!(
                switches[1..],
                [
                    "otel.trace_exporter=\"none\"",
                    "otel.metrics_exporter=\"none\"",
                    "otel.log_user_prompt=false",
                    "otel.tool_result.max_bytes=0",
                    "otel.log_agent_responses=false",
                    "otel.log_guardian_assessments=false",
                    "otel.log_sse_deltas=false",
                ]
            );
            let (_, value) = headers.expect("the token is in the environment");
            let presented = value
                .strip_prefix("authorization=")
                .expect("the header is the authorization");
            let token = presented
                .strip_prefix("Bearer ")
                .expect("the authorization presents a bearer");
            assert!(
                launch
                    .arguments
                    .iter()
                    .all(|argument| !argument.contains(token)),
                "the token is on the command line"
            );
            let (_, attributes) = tag.expect("the launch's tag is in the environment");
            let number: u64 = attributes
                .strip_prefix("sidekicks.codex.service=")
                .expect("the attributes are the launch's tag")
                .parse()
                .expect("the tag is a number");
            assert_eq!(
                bearers.resolve(&DESCRIPTOR.provider_id(), Some(presented.as_bytes())),
                Some(TelemetryHolderId::new(number)),
                "the launch's token resolves to its own tag"
            );
        }
        LaunchTelemetry::ExportersOff => {
            assert_eq!(switches, EXPORTERS_OFF, "{:?}", launch.arguments);
            assert!(headers.is_none(), "{headers:?}");
            assert!(tag.is_none(), "{tag:?}");
        }
        LaunchTelemetry::PersonsOwn => {
            assert!(switches.is_empty(), "{switches:?}");
            assert!(headers.is_none(), "{headers:?}");
            assert!(tag.is_none(), "{tag:?}");
            assert!(launch.environment.contains(&persons_headers));
        }
    }

    let command_switches = home_exec_switches(&home_kind);
    let command_otel: Vec<&str> = command_switches
        .chunks(2)
        .map(|pair| {
            assert_eq!(pair[0], "-c", "{command_switches:?}");
            pair[1].as_str()
        })
        .filter(|switch| switch.starts_with("otel."))
        .collect();
    if home_kind == CodexHomeKind::PersonalFolder {
        assert!(command_otel.is_empty(), "{command_otel:?}");
    } else {
        assert_eq!(command_otel, EXPORTERS_OFF);
    }
    if matches!(home_kind, CodexHomeKind::Account(_)) {
        let executor = compose_codex_executor_arguments(&home_kind);
        let executor_otel: Vec<&str> = executor
            .iter()
            .map(String::as_str)
            .filter(|argument| argument.starts_with("otel."))
            .collect();
        assert_eq!(executor_otel, EXPORTERS_OFF, "{executor:?}");
        assert_eq!(
            executor[executor.len() - 3..],
            ["exec-server", "--listen", "stdio"]
        );
    }
}
