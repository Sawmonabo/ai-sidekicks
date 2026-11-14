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
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::usage::{held_keys, metered_filing, recorded_rows};
use super::{filing_over, locked_down_config};
use crate::bounded_poll::poll_until;
use crate::driver::child_records::UnrecordedChildren;
use crate::driver::codex::lifecycle::naming::lockdown::read_exec_overrides;
use crate::driver::codex::lifecycle::naming::one_shot::name_in_one_shot;
use crate::driver::codex::lifecycle::naming::{CODEX_NAMING_DEADLINE, CODEX_SERVER_LIST_DEADLINE};
use crate::driver::codex::lifecycle::tests::usage::GatedUsage;
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome, CodexServiceKind};
use crate::driver::codex::service::supervisor::test_service::{
    TestCodexProgram, UnheardEvents, script_codex_service, test_codex_service_dependencies,
};
use crate::driver::codex::service::supervisor::{CodexService, CodexServiceSocket};
use crate::driver::codex::transport::connection::CODEX_REQUEST_TIMEOUT;
use crate::driver::codex::transport::connection::scripted_service::ScriptedService;
use crate::driver::ports::DriverPorts;
use crate::port::usage_sink::MeteredUsageOwner;

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
            first_call_wait: None,
        },
    )
    .expect("the stand-in is written")
}

// A service whose program is `program`, with its folders under `folder`, up on a connection the
// test scripts; on the person's own folder, whose commands carry no store switch, so the stand-in
// reads the server list by its first argument.
fn service_running(folder: &Path, program: PathBuf) -> (Arc<CodexService>, ScriptedService) {
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
            kind: CodexHomeKind::PersonalFolder,
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
    let (service, mut script) = service_running(folder.path(), program);
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
    let (service, mut script) = service_running(folder.path(), program);
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

// Real time, since the list's fetch carries a client timeout. The exec names nothing, yet its
// printed counts are one row as the session's own on the filing's binding at the session model it
// ran, held under that model with no tier and no region. Killed by dropping `--json`, by leaving
// the printed counts unread (no row), by recording only once an answer was read (the stand-in
// writes none, so no row), and by leaving the model unstamped (nothing held).
#[tokio::test]
async fn a_one_shot_pass_records_its_counts_as_the_session_s_spend() {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let arguments_file = folder.path().join("arguments");
    let program = write_stand_in(folder.path(), ("[]", 0), &arguments_file, (EXEC_EVENTS, 0));
    let (service, mut script) = service_running(folder.path(), program);
    let usage = Arc::new(GatedUsage::new(watch::channel(true).1));
    let stop = CancellationToken::new();
    let (filing, _server) = metered_filing(&usage, folder.path(), &stop).await;
    let binding = filing.binding_id.as_str().to_owned();
    // The catalog offers no small model; the row's region is read once the exec ran.
    let served = tokio::spawn(async move {
        let listed = script.next_sent().await;
        assert_eq!(listed["method"], "model/list");
        let models = [json!({"id": "gpt-5", "displayName": "GPT-5", "hidden": false})];
        script.answer(&listed, &json!({"data": models, "nextCursor": null}));
        let region = script.next_sent().await;
        assert_eq!(region["method"], "config/read");
        script.answer(&region, &json!({"config": {}, "origins": {}}));
        script
    });

    let named = name_in_one_shot(
        &service,
        "Name this.",
        Some("gpt-5"),
        Instant::now() + CODEX_NAMING_DEADLINE,
        &CancellationToken::new(),
        filing,
    )
    .await;
    drop(served.await.expect("the catalog and the region were read"));
    stop.cancel();

    assert_eq!(
        named.expect("the pass ran"),
        None,
        "the stand-in names nothing"
    );
    let arguments = read_recorded_arguments(&arguments_file).expect("`exec` ran");
    assert!(arguments.iter().any(|argument| argument == "--json"));
    assert_eq!(
        recorded_rows(&usage),
        [(binding, MeteredUsageOwner::Session, Some(1_200), Some(30))]
    );
    assert_eq!(held_keys(&usage), [(Some("gpt-5".to_owned()), None, None)]);
}

// Real time, as above. The exec waits for a release file once started, so the cancel lands while it
// runs; it then prints its turn's counts and ends. Killed by a cancel that drops the running exec,
// which kills it with its request done and files no row.
#[tokio::test]
async fn a_one_shot_pass_canceled_mid_exec_still_records_its_counts() {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let (started, release) = (folder.path().join("started"), folder.path().join("release"));
    let program = folder.path().join("codex");
    let stand_in = format!(
        "#!/bin/sh\nif [ \"$1\" = mcp ]; then printf '[]'; exit 0; fi\n: > '{}'\n\
         while [ ! -e '{}' ]; do sleep 0.05; done\nprintf '%s' '{EXEC_EVENTS}'\n",
        started.display(),
        release.display(),
    );
    write_file_atomically(&program, stand_in, 0o755)
        .await
        .expect("the stand-in is written");
    let (service, mut script) = service_running(folder.path(), program);
    let usage = Arc::new(GatedUsage::new(watch::channel(true).1));
    let stop = CancellationToken::new();
    let (filing, _server) = metered_filing(&usage, folder.path(), &stop).await;
    let served = tokio::spawn(async move {
        let listed = script.next_sent().await;
        assert_eq!(listed["method"], "model/list");
        let models = [json!({"id": "gpt-5", "displayName": "GPT-5", "hidden": false})];
        script.answer(&listed, &json!({"data": models, "nextCursor": null}));
        let region = script.next_sent().await;
        assert_eq!(region["method"], "config/read");
        script.answer(&region, &json!({"config": {}, "origins": {}}));
        script
    });
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
    poll_until(|| started.exists(), |is_started| *is_started).await;
    cancel.cancel();
    std::fs::write(&release, "").expect("the exec is released");
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
