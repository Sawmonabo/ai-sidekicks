use std::path::Path;
use std::sync::Arc;

use opentelemetry_proto::tonic::common::v1::any_value::Value;
use opentelemetry_proto::tonic::common::v1::{AnyValue, KeyValue};
use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};
use sidekicks_platforms::{
    StandInAnswer, StandInHold, StandInProgram, read_recorded_arguments, real_path,
    write_stand_in_program,
};
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
use crate::driver::contract::account::{ProviderWindowTurnLegs, WindowTurnAnswer, WindowTurnSpend};
use crate::driver::schema::schema_parts;
use crate::driver::test_registry::NothingServed;
use crate::pricing::receiver::bearers::TelemetryBearers;
use crate::pricing::receiver::{TelemetryExportReader as _, TelemetryTarget};
use crate::runtime_binding::test_store::test_provider_account_id;
use crate::usage_delta_accountant::UsageAxisCounts;

/// The events the turn prints: its thread, its start and its end with its counts.
const TURN_EVENTS: &str = concat!(
    r#"{"type":"thread.started","thread_id":"t"}"#,
    "\n",
    r#"{"type":"turn.started"}"#,
    "\n",
    r#"{"type":"turn.completed","usage":{"input_tokens":1200,"cached_input_tokens":1000,"#,
    r#""output_tokens":20,"reasoning_output_tokens":8}}"#,
    "\n",
);

// Where a stand-in for Codex in `root` keeps what each call ran with: `mcp list --json`'s
// arguments in `<record>-list`; the turn's arguments, then its home, its folder and its export's
// tag and headers, a line each, in `record`, which it marks written and then waits for its
// release.
fn write_stand_in(root: &Path, record: &Path, exit_code: u8) -> std::path::PathBuf {
    let with_suffix = |suffix: &str| root.join(format!("record-{suffix}"));
    write_stand_in_program(
        root,
        "codex",
        &StandInProgram {
            answers_by_argument: vec![(
                "mcp".to_owned(),
                StandInAnswer {
                    standard_output: r#"[{"name":"docs","enabled":true}]"#.to_owned(),
                    argument_record: Some(with_suffix("list")),
                    ..StandInAnswer::default()
                },
            )],
            otherwise: StandInAnswer {
                standard_output: TURN_EVENTS.to_owned(),
                exit_code,
                argument_record: Some(record.to_owned()),
                recorded_environment: [
                    "CODEX_HOME",
                    "PWD",
                    "OTEL_RESOURCE_ATTRIBUTES",
                    "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
                ]
                .map(str::to_owned)
                .to_vec(),
                hold: Some(StandInHold {
                    waiting: with_suffix("written"),
                    release: with_suffix("release"),
                }),
            },
            first_call_wait: None,
        },
    )
    .expect("the stand-in is written")
}

// One completed response on the turn's thread at `model` and `tier`, with `counts`.
fn exported_record(
    model: &str,
    tier: &str,
    counts: &UsageAxisCounts,
) -> opentelemetry_proto::tonic::logs::v1::LogRecord {
    let mut attributes = completed_response_attributes("t", counts);
    for attribute in &mut attributes {
        let value = match attribute.key.as_str() {
            "model" => model,
            "service_tier" => tier,
            _ => continue,
        };
        *attribute = KeyValue {
            key: attribute.key.clone(),
            value: Some(AnyValue {
                value: Some(Value::StringValue(value.to_owned())),
            }),
            ..Default::default()
        };
    }
    codex_record(attributes)
}

/// The counts the exporting cases' turn exports in its first completed response.
const EXPORTED_COUNTS: UsageAxisCounts = UsageAxisCounts {
    input: Some(500),
    cached_input: Some(100),
    cache_write_input: None,
    output: Some(7),
    reasoning_output: Some(2),
    total: Some(507),
};

/// The counts of the warm-up request a turn exports beside its own.
const WARM_UP_COUNTS: UsageAxisCounts = UsageAxisCounts {
    input: Some(2),
    cached_input: None,
    cache_write_input: None,
    output: Some(0),
    reasoning_output: None,
    total: Some(2),
};

// One request's spend as the test reads it: model, tier, input, cache reads, output, reasoning.
type ReadSpend = (String, Option<String>, u64, u64, u64, u64);

fn read_spend(spend: &WindowTurnSpend) -> ReadSpend {
    let count = |count: Option<SafeInt<0>>| count.map_or(0, SafeInt::get);
    (
        spend
            .model_id
            .as_ref()
            .map(FreeFormText::as_str)
            .unwrap_or_default()
            .to_owned(),
        spend
            .speed
            .as_ref()
            .map(|speed| BoundedText::as_str(speed).to_owned()),
        count(spend.input_tokens),
        count(spend.cache_read_tokens),
        count(spend.output_tokens),
        count(spend.reasoning_tokens),
    )
}

// Before the telemetry target is registered the turn's printed counts are its spend at the small
// model; once registered each exported response is a spend of its own, at the model and tier its
// record names, whether the command ends clean or failed, and the printed counts, which differ,
// are unread; a clean turn that exported nothing is spent at its printed counts. Killed by the
// turn run in another home than the account's (the default one, or the home a session's account
// resolves to), in a project folder, by a second run, by the account's MCP servers left on, by the
// small model dropped, by the home's file store dropped from the turn or from the server list, by
// the cached input left inside the input, by the printed counts read on the export's path, by a
// failed command's exported response dropped (an error), by the export taken with no target, by
// the responses summed under the first's model or with the tier dropped, and by a turn that
// exported nothing spent at no tokens.
#[rstest]
#[case::before_the_target(false, 0, Vec::new())]
#[case::exported(true, 0, vec![("gpt-5.6-luna", "priority", EXPORTED_COUNTS)])]
#[case::exported_then_failed(true, 1, vec![("gpt-5.6-luna", "priority", EXPORTED_COUNTS)])]
#[case::exported_at_two_models(
    true,
    0,
    vec![
        ("gpt-5.6-luna", "priority", EXPORTED_COUNTS),
        ("gpt-5.3-codex", "flex", WARM_UP_COUNTS),
    ]
)]
#[case::exported_nothing(true, 0, Vec::new())]
#[tokio::test(flavor = "multi_thread")]
async fn one_exec_runs_in_the_account_s_home_and_its_counts_are_the_spend(
    #[case] is_registered: bool,
    #[case] exit_code: u8,
    #[case] exported: Vec<(&str, &str, UsageAxisCounts)>,
) {
    let scratch = tempfile::tempdir().expect("a scratch folder is made");
    let root = real_path(scratch.path()).expect("the scratch folder resolves");
    let record = root.join("record");
    let program = write_stand_in(&root, &record, exit_code);
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

    let exported_turn = async {
        let written = root.join("record-written");
        poll_until(|| written.exists(), |is_written| *is_written).await;
        let lines = read_recorded_arguments(&record).expect("the turn wrote its record");
        let (tag, headers) = (&lines[lines.len() - 2], &lines[lines.len() - 1]);
        let presented = headers.strip_prefix("authorization=");
        if is_registered {
            let holder = bearers
                .resolve(&DESCRIPTOR.provider_id(), presented.map(str::as_bytes))
                .expect("the turn's token is admitted while it runs");
            let records: Vec<_> = exported
                .iter()
                .map(|(model, tier, counts)| exported_record(model, tier, counts))
                .collect();
            if !records.is_empty() {
                exports
                    .read_telemetry_export(holder, export_carrying(tag, records))
                    .await;
            }
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
        exported_turn
    );

    let WindowTurnAnswer::Spent(spends) = answer.expect("the turn answers") else {
        panic!("the turn spends");
    };
    let expected: Vec<ReadSpend> = if exported.is_empty() {
        vec![(CODEX_SMALL_MODEL.to_owned(), None, 200, 1000, 20, 8)]
    } else {
        exported
            .iter()
            .map(|(model, tier, counts)| {
                let cached = counts.cached_input.unwrap_or(0);
                (
                    (*model).to_owned(),
                    Some((*tier).to_owned()),
                    counts.input.unwrap_or(0) - cached,
                    cached,
                    counts.output.unwrap_or(0),
                    counts.reasoning_output.unwrap_or(0),
                )
            })
            .collect()
    };
    assert_eq!(spends.iter().map(read_spend).collect::<Vec<_>>(), expected);
    let lines = read_recorded_arguments(&record).expect("the stand-in recorded its run");
    let (arguments, environment) = lines.split_at(lines.len() - 4);
    assert_eq!(
        arguments.iter().filter(|line| *line == "exec").count(),
        1,
        "one turn runs"
    );
    assert_eq!(Path::new(&environment[0]), account_home);
    assert!(
        !Path::new(&environment[1]).starts_with(&root),
        "the turn runs in an empty folder of its own: {}",
        environment[1]
    );
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
