use std::path::Path;
use std::sync::Arc;

use serde_json::json;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_platforms::real_path;
use sidekicks_std::file::atomic_write::write_file_atomically;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_store::database::writer::test_file::TestDatabase;

use super::CODEX_WINDOW_TURN_ARGUMENTS;
use crate::account::registry::open_test_registry;
use crate::driver::ProviderAccountFolders;
use crate::driver::child_records::UnrecordedChildren;
use crate::driver::codex::account::{CODEX_FILE_CREDENTIAL_STORE, CodexAccountLegs};
use crate::driver::codex::lifecycle::naming::CODEX_SMALL_MODEL;
use crate::driver::codex::lifecycle::naming::lockdown::read_exec_overrides;
use crate::driver::codex::rate_limits::CodexRateLimitFiling;
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome};
use crate::driver::codex::service::registry::{CodexServiceRegistry, OneHome};
use crate::driver::codex::service::supervisor::test_service::{
    ProgramPerHome, TestCodexProgram, UnheardEvents, test_codex_service_dependencies,
};
use crate::driver::contract::account::{ProviderWindowTurnLegs, WindowTurnAnswer};
use crate::driver::schema::schema_parts;
use crate::driver::test_registry::NothingServed;
use crate::runtime_binding::test_store::test_provider_account_id;

// A stand-in for Codex: `mcp list --json` writes its arguments, one a line, to `record`'s list
// record and names one server; any other call appends its home, its folder and its arguments, one
// a line, to `record`, then writes a turn's events.
fn stand_in(record: &Path) -> String {
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
printf '%s\n' '{{"type":"thread.started","thread_id":"t"}}'
printf '%s\n' '{{"type":"turn.started"}}'
printf '%s\n' '{{"type":"turn.completed","usage":{{"input_tokens":1200,"cached_input_tokens":1000,"output_tokens":20,"reasoning_output_tokens":8}}}}'
"#,
        record = record.display()
    )
}

// Killed by the turn run in another home than the account's (the default one, or the home a
// session's account resolves to), in a project folder, by a second run, by the account's MCP
// servers left on, by the small model dropped, by the home's file store dropped from the turn or
// from the server list, and by the cached input left inside the input.
#[tokio::test(flavor = "multi_thread")]
async fn one_exec_runs_in_the_account_s_home_and_its_counts_are_the_spend() {
    let scratch = tempfile::tempdir().expect("a scratch folder is made");
    let root = real_path(scratch.path()).expect("the scratch folder resolves");
    let program = root.join("codex");
    let record = root.join("record");
    write_file_atomically(&program, stand_in(&record), 0o755)
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

    let answer = legs
        .start_window(test_provider_account_id(), folders)
        .await
        .expect("the turn answers");

    let WindowTurnAnswer::Spent(spend) = answer else {
        panic!("a completed turn spends: {answer:?}");
    };
    assert_eq!(
        spend.model_id.as_ref().map(FreeFormText::as_str),
        Some(CODEX_SMALL_MODEL)
    );
    let count = |count: Option<SafeInt<0>>| count.map(SafeInt::get);
    assert_eq!(count(spend.input_tokens), Some(200));
    assert_eq!(count(spend.cache_read_tokens), Some(1000));
    assert_eq!(count(spend.output_tokens), Some(20));
    assert_eq!(count(spend.reasoning_tokens), Some(8));
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
