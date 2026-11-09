//! The one-shot pass, run against a stand-in for Codex's program.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use rstest::rstest;
use serde_json::json;
use sidekicks_platforms::{
    StandInAnswer, StandInHold, StandInProgram, read_recorded_arguments, write_stand_in_program,
};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::usage::{held_keys, metered_filing, recorded_rows};
use super::{filing_over, locked_down_config};
use crate::bounded_poll::poll_until;
use crate::driver::child_records::UnrecordedChildren;
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::lifecycle::naming::lockdown::read_exec_overrides;
use crate::driver::codex::lifecycle::naming::one_shot::name_in_one_shot;
use crate::driver::codex::lifecycle::naming::{CODEX_NAMING_DEADLINE, CODEX_SERVER_LIST_DEADLINE};
use crate::driver::codex::lifecycle::tests::usage::GatedUsage;
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome, CodexServiceKind};
use crate::driver::codex::service::supervisor::test_service::{
    TestCodexProgram, UnheardEvents, script_codex_service, test_codex_service_dependencies,
};
use crate::driver::codex::service::supervisor::{CodexService, CodexServiceSocket};
use crate::driver::codex::telemetry::completed_response::tests::{
    codex_record, completed_response_attributes,
};
use crate::driver::codex::telemetry::exports::tests::export_carrying;
use crate::driver::codex::transport::connection::CODEX_REQUEST_TIMEOUT;
use crate::driver::codex::transport::connection::scripted_service::ScriptedService;
use crate::driver::ports::DriverPorts;
use crate::port::usage_sink::MeteredUsageOwner;
use crate::pricing::receiver::bearers::TelemetryBearers;
use crate::pricing::receiver::{TelemetryExportReader as _, TelemetryTarget};
use crate::runtime_binding::test_store::test_provider_account_id;
use crate::usage_delta_accountant::UsageAxisCounts;

/// What a one-shot pass's `codex exec --json` prints: its thread's start and its turn's counts.
const EXEC_EVENTS: &str = concat!(
    r#"{"type":"thread.started","thread_id":"exec-thread"}"#,
    "\n",
    r#"{"type":"turn.completed","usage":{"input_tokens":1200,"cached_input_tokens":1000,"#,
    r#""output_tokens":30,"reasoning_output_tokens":0}}"#,
    "\n",
);

// A stand-in for Codex's program in `folder`, and where its exec writes what it ran with: the
// exec's record holds its arguments, then its export's tag and headers, a line each; a held exec
// marks `waiting` once it wrote them and waits for `release`.
struct StandIn {
    program: PathBuf,
    record: PathBuf,
    waiting: PathBuf,
    release: PathBuf,
}

impl StandIn {
    // A stand-in in `folder` whose `mcp list --json`, wherever the home's switches put it, prints
    // `listing` and exits with `list_exit`; any other call records what it ran with, waits for
    // its release where `is_held`, prints `exec_printed` and exits with `exec_exit`.
    fn write(
        folder: &Path,
        (listing, list_exit): (&str, u8),
        (exec_printed, exec_exit): (&str, u8),
        is_held: bool,
    ) -> Self {
        let (record, waiting, release) = (
            folder.join("record"),
            folder.join("waiting"),
            folder.join("release"),
        );
        let program = write_stand_in_program(
            folder,
            "codex",
            &StandInProgram {
                answers_by_argument: vec![(
                    "mcp".to_owned(),
                    StandInAnswer {
                        standard_output: listing.to_owned(),
                        exit_code: list_exit,
                        ..StandInAnswer::default()
                    },
                )],
                otherwise: StandInAnswer {
                    standard_output: exec_printed.to_owned(),
                    exit_code: exec_exit,
                    argument_record: Some(record.clone()),
                    recorded_environment: vec![
                        "OTEL_RESOURCE_ATTRIBUTES".to_owned(),
                        "OTEL_EXPORTER_OTLP_LOGS_HEADERS".to_owned(),
                    ],
                    hold: is_held.then(|| StandInHold {
                        waiting: waiting.clone(),
                        release: release.clone(),
                    }),
                },
                first_call_wait: None,
            },
        )
        .expect("the stand-in is written");
        Self {
            program,
            record,
            waiting,
            release,
        }
    }

    // What the exec ran with: its arguments, then its export's tag and headers, each empty where
    // the exec carries none.
    fn recorded(&self) -> (Vec<String>, String, String) {
        let mut lines = read_recorded_arguments(&self.record).expect("the exec wrote its record");
        let headers = lines.pop().expect("the record ends with the headers");
        let tag = lines.pop().expect("the headers follow the tag");
        (lines, tag, headers)
    }

    // Once a held exec wrote what it ran with, what that was.
    async fn ran_with(&self) -> (Vec<String>, String, String) {
        poll_until(|| self.waiting.exists(), |is_waiting| *is_waiting).await;
        self.recorded()
    }

    fn release(&self) {
        std::fs::write(&self.release, "").expect("the exec is released");
    }
}

// A service on a home of `home_kind` whose program is `program`, with its folders under `folder`,
// up on a connection the test scripts. A home of the person's own folder carries no store switch,
// so a stand-in reads the server list by its first argument.
fn service_running(
    folder: &Path,
    program: PathBuf,
    home_kind: CodexHomeKind,
) -> (Arc<CodexService>, ScriptedService) {
    let dependencies = test_codex_service_dependencies(
        folder,
        Arc::new(TestCodexProgram {
            program,
            environment: Vec::new(),
        }),
        Arc::new(UnheardEvents),
        Arc::new(UnrecordedChildren),
    );
    let socket = folder.join("codex.sock");
    script_codex_service(
        CodexServiceHome {
            codex_home: folder.join("home"),
            kind: home_kind,
        },
        CodexServiceSocket {
            path: socket.clone(),
            home_socket: socket,
        },
        CodexServiceKind::Account,
        dependencies,
    )
}

// Killed by skipping the server list (`exec` would run with no server named in the failing case,
// and with the listed servers left on in the other), and by dropping the small title model the
// service's catalog offers.
#[rstest]
#[case::a_listed_home(0, true)]
#[case::an_unlisted_home(1, false)]
#[tokio::test]
async fn a_one_shot_pass_disables_every_listed_server_or_runs_no_exec(
    #[case] list_exit: u8,
    #[case] is_listed: bool,
) {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let listing =
        r#"[{"name": "docs", "enabled": true}, {"name": "team.search", "enabled": true}]"#;
    let stand_in = StandIn::write(folder.path(), (listing, list_exit), ("", 1), false);
    let (service, mut script) = service_running(
        folder.path(),
        stand_in.program.clone(),
        CodexHomeKind::PersonalFolder,
    );
    // Read only once the servers are listed; the catalog offers the small title model.
    let catalog = is_listed.then(|| {
        tokio::spawn(async move {
            let listed = script.next_sent().await;
            assert_eq!(listed["method"], "model/list");
            script.answer(
                &listed,
                &json!({
                    "data": [{"id": "gpt-5.6-luna", "displayName": "Luna", "hidden": false}],
                    "nextCursor": null,
                }),
            );
            script
        })
    });

    let named = name_in_one_shot(
        &service,
        "Name this.",
        Some("gpt-5"),
        Instant::now() + CODEX_NAMING_DEADLINE,
        &CancellationToken::new(),
        filing_over(&DriverPorts::new()),
    )
    .await;

    if let Some(catalog) = catalog {
        assert_eq!(
            named.expect("the pass ran"),
            None,
            "the stand-in names nothing"
        );
        catalog.await.expect("the catalog was read");
        let (arguments, _tag, _headers) = stand_in.recorded();
        let mut expected = locked_down_config();
        expected["model"] = json!("gpt-5.6-luna");
        expected["model_reasoning_effort"] = json!("low");
        assert_eq!(read_exec_overrides(&arguments), expected);
    } else {
        assert!(named.is_err(), "an unread list fails the pass");
        assert!(!stand_in.record.exists(), "`exec` never ran");
    }
}

// Real time through the server list, then the clock stops while the catalog read waits. Killed by
// reading the catalog outside the pass's deadline: the pass would wait out the read's own bound,
// past the test's.
#[tokio::test]
async fn a_one_shot_pass_whose_catalog_never_answers_ends_at_its_deadline_with_nothing_run() {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let stand_in = StandIn::write(folder.path(), ("[]", 0), ("", 1), false);
    let (service, mut script) = service_running(
        folder.path(),
        stand_in.program.clone(),
        CodexHomeKind::PersonalFolder,
    );
    let unanswered = tokio::spawn(async move {
        let listed = script.next_sent().await;
        assert_eq!(listed["method"], "model/list");
        tokio::time::pause();
        // Kept, so the connection stays open with the read unanswered.
        script
    });

    let named = tokio::time::timeout(
        CODEX_REQUEST_TIMEOUT,
        name_in_one_shot(
            &service,
            "Name this.",
            Some("gpt-5"),
            Instant::now() + CODEX_SERVER_LIST_DEADLINE,
            &CancellationToken::new(),
            filing_over(&DriverPorts::new()),
        ),
    )
    .await
    .expect("the pass ends at its deadline, before the catalog read's own bound");

    assert_eq!(named.expect("a pass past its deadline names nothing"), None);
    assert!(!stand_in.record.exists(), "`exec` never ran");
    drop(unanswered.await.expect("the catalog read was sent"));
}

// What the catalog and the region read answer on a pass's service: one model and no region.
fn serve_catalog_and_region(mut script: ScriptedService) -> JoinHandle<ScriptedService> {
    tokio::spawn(async move {
        let listed = script.next_sent().await;
        assert_eq!(listed["method"], "model/list");
        let models = [json!({"id": "gpt-5", "displayName": "GPT-5", "hidden": false})];
        script.answer(&listed, &json!({"data": models, "nextCursor": null}));
        let region = script.next_sent().await;
        assert_eq!(region["method"], "config/read");
        script.answer(&region, &json!({"config": {}, "origins": {}}));
        script
    })
}

// Real time, since the list's fetch carries a client timeout. The exec names nothing, yet its
// spend is the session's own on the filing's binding: on an account's home once the telemetry
// target is registered, each response its export stated, at the model and tier the record names,
// with the printed counts, which differ, unread, and a failed exec's responses counted too; before
// the target, on a home that exports nowhere, or where the export stated nothing, its printed
// counts, one row at the session model it ran, held under that model with no tier. Killed by
// dropping `--json`, by leaving the printed counts unread (no row before the target), by recording
// only once an answer was read (the stand-in writes none, so no row), by leaving the model
// unstamped (nothing held), by the printed counts read on the export's path (a 1,200 row), by
// dropping a failed exec's export (no row in the failed case), by counting an exec that exported
// nothing as no spend (no row), by the export taken with no target or on the person's own home (a
// tag), by a token the receiver refuses while the exec runs, and by one it admits after.
#[rstest]
#[case::before_the_target(true, false, 0, Vec::new(), vec![(1_200, 30)], "gpt-5", None)]
#[case::exported(true, true, 0, vec![(700, 9)], vec![(700, 9)], "gpt-5.6-luna", Some("priority"))]
#[case::exported_then_failed(
    true,
    true,
    1,
    vec![(700, 9), (300, 4)],
    vec![(700, 9), (300, 4)],
    "gpt-5.6-luna",
    Some("priority")
)]
#[case::exported_nothing(true, true, 0, Vec::new(), vec![(1_200, 30)], "gpt-5", None)]
#[case::own_home_with_the_target(false, true, 0, Vec::new(), vec![(1_200, 30)], "gpt-5", None)]
#[tokio::test]
async fn a_one_shot_pass_records_its_counts_as_the_session_s_spend(
    #[case] is_account_home: bool,
    #[case] is_registered: bool,
    #[case] exec_exit: u8,
    #[case] exported: Vec<(u64, u64)>,
    #[case] expected_rows: Vec<(u64, u64)>,
    #[case] expected_model: &str,
    #[case] expected_speed: Option<&str>,
) {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let stand_in = StandIn::write(folder.path(), ("[]", 0), (EXEC_EVENTS, exec_exit), true);
    let home_kind = if is_account_home {
        CodexHomeKind::Account(test_provider_account_id())
    } else {
        CodexHomeKind::PersonalFolder
    };
    let (service, script) = service_running(folder.path(), stand_in.program.clone(), home_kind);
    let bearers = Arc::new(TelemetryBearers::default());
    if is_registered {
        let target = Arc::new(TelemetryTarget::new(4318, Arc::clone(&bearers)));
        assert!(
            service
                .dependencies()
                .telemetry_target
                .register(target)
                .is_ok()
        );
    }
    let usage = Arc::new(GatedUsage::new(watch::channel(true).1));
    let stop = CancellationToken::new();
    let (filing, _server) = metered_filing(&usage, folder.path(), &stop).await;
    let binding = filing.binding_id.as_str().to_owned();
    let served = serve_catalog_and_region(script);

    let pass = tokio::spawn({
        let service = Arc::clone(&service);
        async move {
            let deadline = Instant::now() + CODEX_NAMING_DEADLINE;
            let cancel = CancellationToken::new();
            name_in_one_shot(
                &service,
                "Name this.",
                Some("gpt-5"),
                deadline,
                &cancel,
                filing,
            )
            .await
        }
    });
    let (arguments, tag, headers) = stand_in.ran_with().await;
    let presented = headers.strip_prefix("authorization=").map(str::as_bytes);
    if is_registered && is_account_home {
        let holder = bearers
            .resolve(&DESCRIPTOR.provider_id(), presented)
            .expect("the exec's token is admitted while it runs");
        let records: Vec<_> = exported
            .iter()
            .map(|&(input, output)| {
                let counts = UsageAxisCounts {
                    input: Some(input),
                    output: Some(output),
                    total: Some(input + output),
                    ..UsageAxisCounts::default()
                };
                codex_record(completed_response_attributes("exec-thread", &counts))
            })
            .collect();
        if !records.is_empty() {
            service
                .dependencies()
                .exports
                .read_telemetry_export(holder, export_carrying(&tag, records))
                .await;
        }
    } else {
        assert!(tag.is_empty(), "this exec exports nowhere: {tag}");
    }
    stand_in.release();
    let named = pass.await.expect("the pass ran to its end");
    drop(served.await.expect("the catalog and the region were read"));
    stop.cancel();

    assert_eq!(
        named.expect("the pass ran"),
        None,
        "the stand-in names nothing"
    );
    assert!(arguments.iter().any(|argument| argument == "--json"));
    assert_eq!(
        bearers.resolve(&DESCRIPTOR.provider_id(), presented),
        None,
        "the exec's token is refused once it ended"
    );
    let expected: Vec<_> = expected_rows
        .into_iter()
        .map(|(input, output)| {
            let owner = MeteredUsageOwner::Session;
            (binding.clone(), owner, Some(input), Some(output))
        })
        .collect();
    assert_eq!(recorded_rows(&usage), expected);
    let key = (
        Some(expected_model.to_owned()),
        expected_speed.map(str::to_owned),
        None::<String>,
    );
    assert_eq!(held_keys(&usage), vec![key; expected.len()]);
}

// Real time, as above. The exec waits for its release once started, so the cancel lands while it
// runs; it then prints its turn's counts and ends. Killed by a cancel that drops the running exec,
// which kills it with its request done and files no row.
#[tokio::test]
async fn a_one_shot_pass_canceled_mid_exec_still_records_its_counts() {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let stand_in = StandIn::write(folder.path(), ("[]", 0), (EXEC_EVENTS, 0), true);
    let (service, script) = service_running(
        folder.path(),
        stand_in.program.clone(),
        CodexHomeKind::PersonalFolder,
    );
    let usage = Arc::new(GatedUsage::new(watch::channel(true).1));
    let stop = CancellationToken::new();
    let (filing, _server) = metered_filing(&usage, folder.path(), &stop).await;
    let served = serve_catalog_and_region(script);
    let cancel = CancellationToken::new();

    let pass = tokio::spawn({
        let (service, cancel) = (Arc::clone(&service), cancel.clone());
        async move {
            let deadline = Instant::now() + CODEX_NAMING_DEADLINE;
            name_in_one_shot(
                &service,
                "Name this.",
                Some("gpt-5"),
                deadline,
                &cancel,
                filing,
            )
            .await
        }
    });
    stand_in.ran_with().await;
    cancel.cancel();
    stand_in.release();
    let named = pass.await.expect("the pass ran to its end");
    drop(served.await.expect("the catalog and the region were read"));
    stop.cancel();

    assert_eq!(
        named.expect("the pass ran"),
        None,
        "a canceled pass names nothing"
    );
    assert_eq!(
        recorded_rows(&usage).len(),
        1,
        "the exec's counts are one row"
    );
}
