use std::path::Path;
use std::sync::Arc;

use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_platforms::real_path;
use sidekicks_std::file::atomic_write::write_file_atomically;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_store::database::writer::test_file::TestDatabase;

use super::CODEX_WINDOW_TURN_ARGUMENTS;
use crate::account::registry::open_test_registry;
use crate::bounded_poll::poll_until;
use crate::driver::ProviderAccountFolders;
use crate::driver::child_records::UnrecordedChildren;
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::account::{CODEX_FILE_CREDENTIAL_STORE, CodexAccountLegs};
use crate::driver::codex::lifecycle::naming::CODEX_SMALL_MODEL;
use crate::driver::codex::lifecycle::naming::lockdown::read_exec_overrides;
use crate::driver::codex::rate_limits::CodexRateLimitFiling;
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome};
use crate::driver::codex::service::registry::{CodexServiceRegistry, OneHome};
use crate::driver::codex::service::supervisor::test_service::{
    ProgramPerHome, TestCodexProgram, UnheardEvents, test_codex_service_dependencies,
};
use crate::driver::codex::telemetry::completed_response::tests::{
    codex_record, completed_response_attributes,
};
use crate::driver::codex::telemetry::exports::tests::export_carrying;
use crate::driver::contract::account::{ProviderWindowTurnLegs, WindowTurnAnswer};
use crate::driver::schema::schema_parts;
use crate::driver::test_registry::NothingServed;
use crate::pricing::receiver::bearers::TelemetryBearers;
use crate::pricing::receiver::{TelemetryExportReader as _, TelemetryTarget};
use crate::runtime_binding::test_store::test_provider_account_id;
use crate::usage_delta_accountant::UsageAxisCounts;

// A stand-in for Codex: `mcp list --json` writes its arguments, one a line, to `record`'s list
// record and names one server; any other call appends its home, its folder and its arguments, one
// a line, to `record`, writes its export's tag and headers to `record`'s export record and marks
// it written, waits for `record`'s release, then writes a turn's events and exits with
// `exit_code`.
fn stand_in(record: &Path, exit_code: u8) -> String {
    format!(
        r#"#!/bin/sh
for argument in "$@"; do
  if [ "$argument" = mcp ]; then
    printf '%s\n' "$@" > '{record}-list'
    printf '%s\n' '[{{"name":"docs","enabled":true}}]'
    exit 0
  fi
done
{{ printf 'run\n%s\n%s\n' "$CODEX_HOME" "$PWD"; printf '%s\n' "$@"; }} >> '{record}'
printf '%s\n' "$OTEL_RESOURCE_ATTRIBUTES" "$OTEL_EXPORTER_OTLP_LOGS_HEADERS" > '{record}-export'
: > '{record}-written'
while [ ! -e '{record}-release' ]; do sleep 0.05; done
printf '%s\n' '{{"type":"thread.started","thread_id":"t"}}'
printf '%s\n' '{{"type":"turn.started"}}'
printf '%s\n' '{{"type":"turn.completed","usage":{{"input_tokens":1200,"cached_input_tokens":1000,'\
'"output_tokens":20,"reasoning_output_tokens":8}}}}'
exit {exit_code}
"#,
        record = record.display()
    )
}

/// The counts the exporting cases' turn exports in one completed response.
const EXPORTED_COUNTS: UsageAxisCounts = UsageAxisCounts {
    input: Some(500),
    cached_input: Some(100),
    cache_write_input: None,
    output: Some(7),
    reasoning_output: Some(2),
    total: Some(507),
};

// Before the telemetry target is registered the turn's printed counts are its spend at the small
// model; once registered its exported response is, at the model the record names, whether the
// command ends clean or failed, and the printed counts, which differ, are unread. Killed by the
// turn run in another home than the account's (the default one, or the home a session's account
// resolves to), in a project folder, by a second run, by the account's MCP servers left on, by the
// small model dropped, by the home's file store dropped from the turn or from the server list, by
// the cached input left inside the input, by the printed counts read on the export's path, by a
// failed command's exported response dropped (an error), and by the export taken with no target.
#[rstest]
#[case::before_the_target(false, 0)]
#[case::exported(true, 0)]
#[case::exported_then_failed(true, 1)]
#[tokio::test(flavor = "multi_thread")]
async fn one_exec_runs_in_the_account_s_home_and_its_counts_are_the_spend(
    #[case] is_registered: bool,
    #[case] exit_code: u8,
) {
    let scratch = tempfile::tempdir().expect("a scratch folder is made");
    let root = real_path(scratch.path()).expect("the scratch folder resolves");
    let program = root.join("codex");
    let record = root.join("record");
    write_file_atomically(&program, stand_in(&record, exit_code), 0o755)
        .await
        .expect("the stand-in is written");
    let dependencies = test_codex_service_dependencies(
        &root,
        Arc::new(ProgramPerHome {
            program: TestCodexProgram {
                program,
                environment: vec![("PATH".to_owned(), "/usr/bin:/bin".to_owned())],
            },
            records_folder: root.clone(),
        }),
        Arc::new(UnheardEvents),
        Arc::new(UnrecordedChildren),
    );
    let bearers = Arc::new(TelemetryBearers::default());
    if is_registered {
        let target = Arc::new(TelemetryTarget::new(4318, Arc::clone(&bearers)));
        assert!(dependencies.telemetry_target.register(target).is_ok());
    }
    let exports = Arc::clone(&dependencies.exports);
    let database = TestDatabase::new(schema_parts());
    let (registry, _writer) = open_test_registry(&database, &root.join("data")).await;
    let accounts = Arc::new(PortRegistration::new("provider account registry"));
    assert!(accounts.register(Arc::new(registry)).is_ok());
    let sessions_home = OneHome(CodexServiceHome {
        codex_home: root.join("unpinned"),
        kind: CodexHomeKind::Account(test_provider_account_id()),
    });
    let legs = CodexAccountLegs::new(
        Arc::new(CodexServiceRegistry::new(
            Arc::new(sessions_home),
            Arc::clone(&dependencies),
        )),
        dependencies,
        CodexRateLimitFiling::new(Arc::new(PortRegistration::new("usage"))),
        accounts,
        Arc::new(NothingServed),
        Arc::new(PortRegistration::new("account home lock")),
    );
    let account_home = root.join("account");
    let folders = ProviderAccountFolders {
        configuration_folder: account_home.clone(),
        credential_store_folder: account_home.clone(),
    };

    let exported = async {
        let written = root.join("record-written");
        poll_until(|| written.exists(), |is_written| *is_written).await;
        let export = std::fs::read_to_string(root.join("record-export"))
            .expect("the turn wrote its export's tag and headers");
        let (tag, headers) = export.split_once('\n').expect("the tag's line ends");
        let presented = headers.trim_end().strip_prefix("authorization=");
        if is_registered {
            let holder = bearers
                .resolve(&DESCRIPTOR.provider_id(), presented.map(str::as_bytes))
                .expect("the turn's token is admitted while it runs");
            let response = codex_record(completed_response_attributes("t", &EXPORTED_COUNTS));
            exports
                .read_telemetry_export(holder, export_carrying(tag, vec![response]))
                .await;
        } else {
            assert!(
                tag.is_empty(),
                "a turn before the target exports nowhere: {tag}"
            );
        }
        std::fs::write(root.join("record-release"), "").expect("the turn is released");
    };
    let (answer, ()) = tokio::join!(
        legs.start_window(test_provider_account_id(), folders),
        exported
    );

    let WindowTurnAnswer::Spent(spend) = answer.expect("the turn answers") else {
        panic!("the turn spends");
    };
    let expected = if is_registered {
        ("gpt-5.6-luna", 400, 100, 7, 2)
    } else {
        (CODEX_SMALL_MODEL, 200, 1000, 20, 8)
    };
    let count = |count: Option<SafeInt<0>>| count.map(SafeInt::get);
    assert_eq!(
        (
            spend.model_id.as_ref().map(FreeFormText::as_str),
            count(spend.input_tokens),
            count(spend.cache_read_tokens),
            count(spend.output_tokens),
            count(spend.reasoning_tokens),
        ),
        (
            Some(expected.0),
            Some(expected.1),
            Some(expected.2),
            Some(expected.3),
            Some(expected.4),
        )
    );
    let recorded = tokio::fs::read_to_string(&record)
        .await
        .expect("the stand-in recorded its run");
    let lines: Vec<&str> = recorded.lines().collect();
    assert_eq!(
        lines.iter().filter(|line| **line == "run").count(),
        1,
        "one turn runs"
    );
    assert_eq!(Path::new(lines[1]), account_home);
    assert!(
        !Path::new(lines[2]).starts_with(&root),
        "the turn runs in an empty folder of its own: {}",
        lines[2]
    );
    let arguments = &lines[3..];
    let exec_at = arguments
        .iter()
        .position(|argument| *argument == "exec")
        .expect("the turn runs `exec`");
    assert_eq!(arguments[exec_at..], CODEX_WINDOW_TURN_ARGUMENTS);
    let overrides = read_exec_overrides(arguments);
    assert_eq!(overrides["model"], json!(CODEX_SMALL_MODEL));
    assert_eq!(overrides["cli_auth_credentials_store"], json!("file"));
    let listed = tokio::fs::read_to_string(root.join("record-list"))
        .await
        .expect("the server list ran");
    let listed: Vec<&str> = listed.lines().collect();
    assert!(
        listed
            .windows(2)
            .any(|pair| pair == ["-c", CODEX_FILE_CREDENTIAL_STORE]),
        "the server list ran without the home's file store: {listed:?}"
    );
    assert_eq!(
        overrides["mcp_servers"],
        json!({"docs": {"enabled": false}})
    );
}
