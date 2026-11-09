//! The one-shot pass, run against a stand-in for Codex's program.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use rstest::rstest;
use serde_json::json;
use sidekicks_platforms::{
    StandInAnswer, StandInProgram, read_recorded_arguments, write_stand_in_program,
};
use sidekicks_std::file::atomic_write::write_file_atomically;
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

// A stand-in for Codex's program in `folder`: `codex mcp list --json` prints `listing` and exits
// with `list_exit`; any other call records its arguments in `arguments`, prints `exec_printed`
// and exits with `exec_exit`.
fn write_stand_in(
    folder: &Path,
    (listing, list_exit): (&str, u8),
    arguments: &Path,
    (exec_printed, exec_exit): (&str, u8),
) -> PathBuf {
    write_stand_in_program(
        folder,
        "codex",
        &StandInProgram {
            answers_by_first_argument: vec![(
                "mcp".to_owned(),
                StandInAnswer {
                    standard_output: listing.to_owned(),
                    exit_code: list_exit,
                    argument_record: None,
                },
            )],
            otherwise: StandInAnswer {
                standard_output: exec_printed.to_owned(),
                exit_code: exec_exit,
                argument_record: Some(arguments.to_owned()),
            },
        },
    )
    .expect("the stand-in is written")
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
    let arguments_file = folder.path().join("arguments");
    let listing =
        r#"[{"name": "docs", "enabled": true}, {"name": "team.search", "enabled": true}]"#;
    let program = write_stand_in(
        folder.path(),
        (listing, list_exit),
        &arguments_file,
        ("", 1),
    );
    let (service, mut script) =
        service_running(folder.path(), program, CodexHomeKind::PersonalFolder);
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
        let arguments = read_recorded_arguments(&arguments_file).expect("`exec` ran");
        let mut expected = locked_down_config();
        expected["model"] = json!("gpt-5.6-luna");
        expected["model_reasoning_effort"] = json!("low");
        assert_eq!(read_exec_overrides(&arguments), expected);
    } else {
        assert!(named.is_err(), "an unread list fails the pass");
        assert!(!arguments_file.exists(), "`exec` never ran");
    }
}

// Real time through the server list, then the clock stops while the catalog read waits. Killed by
// reading the catalog outside the pass's deadline: the pass would wait out the read's own bound,
// past the test's.
#[tokio::test]
async fn a_one_shot_pass_whose_catalog_never_answers_ends_at_its_deadline_with_nothing_run() {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let arguments_file = folder.path().join("arguments");
    let program = write_stand_in(folder.path(), ("[]", 0), &arguments_file, ("", 1));
    let (service, mut script) =
        service_running(folder.path(), program, CodexHomeKind::PersonalFolder);
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
    assert!(!arguments_file.exists(), "`exec` never ran");
    drop(unanswered.await.expect("the catalog read was sent"));
}

// Where a held stand-in exec writes what it ran with, the mark it leaves once written, and the
// file it waits for before it ends.
struct HeldExec {
    program: PathBuf,
    record: PathBuf,
    written: PathBuf,
    release: PathBuf,
}

impl HeldExec {
    // A stand-in for Codex's program in `folder` whose `mcp list`, wherever the home's switches
    // put it, names no server; any other call writes its arguments, then the tag and the headers
    // its export carries, a line each, marks them written, waits for its release, prints
    // `exec_printed` and exits with `exec_exit`.
    async fn write(folder: &Path, (exec_printed, exec_exit): (&str, u8)) -> Self {
        let held = Self {
            program: folder.join("codex"),
            record: folder.join("record"),
            written: folder.join("written"),
            release: folder.join("release"),
        };
        let stand_in = format!(
            r#"#!/bin/sh
for argument in "$@"; do
  if [ "$argument" = mcp ]; then printf '[]'; exit 0; fi
done
{{
  printf '%s\n' "$@"
  printf '%s\n' "$OTEL_RESOURCE_ATTRIBUTES"
  printf '%s\n' "$OTEL_EXPORTER_OTLP_LOGS_HEADERS"
}} > '{record}'
: > '{written}'
while [ ! -e '{release}' ]; do sleep 0.05; done
printf '%s' '{exec_printed}'
exit {exec_exit}
"#,
            record = held.record.display(),
            written = held.written.display(),
            release = held.release.display(),
        );
        write_file_atomically(&held.program, stand_in, 0o755)
            .await
            .expect("the stand-in is written");
        held
    }

    // Once the exec wrote what it ran with: its arguments, then its export's tag and headers,
    // each empty where the exec carries none.
    async fn ran_with(&self) -> (Vec<String>, String, String) {
        poll_until(|| self.written.exists(), |is_written| *is_written).await;
        let recorded = std::fs::read_to_string(&self.record).expect("the exec wrote its record");
        let mut lines: Vec<String> = recorded.lines().map(str::to_owned).collect();
        let headers = lines.pop().expect("the record ends with the headers");
        let tag = lines.pop().expect("the headers follow the tag");
        (lines, tag, headers)
    }

    fn release(&self) {
        std::fs::write(&self.release, "").expect("the exec is released");
    }
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
// spend is the session's own on the filing's binding: before the telemetry target is registered
// its printed counts, one row at the session model it ran, held under that model with no tier;
// once registered, each response its export stated, at the model and tier the record names, with
// the printed counts, which differ, unread, and a failed exec's responses counted too. Killed by
// dropping `--json`, by leaving the printed counts unread (no row before the target), by recording
// only once an answer was read (the stand-in writes none, so no row), by leaving the model
// unstamped (nothing held), by the printed counts read on the export's path (a 1,200 row), by
// dropping a failed exec's export (no row in the failed case), by the export taken with no
// target, by a token the receiver refuses while the exec runs, and by one it admits after.
#[rstest]
#[case::before_the_target(false, 0, Vec::new(), vec![(1_200, 30)], "gpt-5", None)]
#[case::exported(true, 0, vec![(700, 9)], vec![(700, 9)], "gpt-5.6-luna", Some("priority"))]
#[case::exported_then_failed(
    true,
    1,
    vec![(700, 9), (300, 4)],
    vec![(700, 9), (300, 4)],
    "gpt-5.6-luna",
    Some("priority")
)]
#[tokio::test]
async fn a_one_shot_pass_records_its_counts_as_the_session_s_spend(
    #[case] is_registered: bool,
    #[case] exec_exit: u8,
    #[case] exported: Vec<(u64, u64)>,
    #[case] expected_rows: Vec<(u64, u64)>,
    #[case] expected_model: &str,
    #[case] expected_speed: Option<&str>,
) {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let held = HeldExec::write(folder.path(), (EXEC_EVENTS, exec_exit)).await;
    let (service, script) = service_running(
        folder.path(),
        held.program.clone(),
        CodexHomeKind::Account(test_provider_account_id()),
    );
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
    let (arguments, tag, headers) = held.ran_with().await;
    let presented = headers.strip_prefix("authorization=").map(str::as_bytes);
    if is_registered {
        let holder = bearers
            .resolve(&DESCRIPTOR.provider_id(), presented)
            .expect("the exec's token is admitted while it runs");
        let records = exported
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
        service
            .dependencies()
            .exports
            .read_telemetry_export(holder, export_carrying(&tag, records))
            .await;
    } else {
        assert!(
            tag.is_empty(),
            "an exec before the target exports nowhere: {tag}"
        );
    }
    held.release();
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
    let held = HeldExec::write(folder.path(), (EXEC_EVENTS, 0)).await;
    let (service, script) = service_running(
        folder.path(),
        held.program.clone(),
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
    held.ran_with().await;
    cancel.cancel();
    held.release();
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
