//! One command run on a real account reads the same through the relay as when Codex runs it
//! itself.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

use crate::driver::child_records::UnrecordedChildren;
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome, CodexServiceKind};
use crate::driver::codex::service::supervisor::test_service::{
    TestCodexProgram, UnheardEvents, test_codex_service_dependencies,
};
use crate::driver::codex::service::supervisor::{CodexService, CodexServiceSocket};
use crate::driver::codex::session::detached_conversation::CodexDetachedFrames;
use crate::driver::codex::thread::settings::compose_codex_relay_environments;
use crate::driver::codex::thread::view::{THREAD_START_METHOD, TURN_START_METHOD};
use crate::runtime_binding::test_store::test_provider_account_id;

/// The one command the parity turn asks Codex to run: two lines, one on standard error, and a
/// failing exit code, so output, order and code are all compared.
const PARITY_COMMAND: &str = "printf 'one\\n'; printf 'two\\n' >&2; exit 3";

/// How long the parity turn may take on a real account.
const PARITY_TURN_DEADLINE: Duration = Duration::from_secs(300);

// One command run in one turn on the signed-in account home `SIDEKICKS_TEST_CODEX_HOME` names,
// with the downloaded Codex build `SIDEKICKS_TEST_CODEX_PROGRAM` names, reads the same output and
// exit code through the relay, on the account's service with the relay's environment selected, as
// when Codex runs it itself, on a service of the same home with no relay. Killed by a relayed
// side that runs its command locally, which the relay's count of process starts shows.
#[tokio::test]
#[ignore = "needs a downloaded Codex release and a signed-in account"]
async fn a_relayed_commands_output_reads_as_codexs_own() {
    let program = std::env::var_os("SIDEKICKS_TEST_CODEX_PROGRAM")
        .expect("SIDEKICKS_TEST_CODEX_PROGRAM names the downloaded Codex program");
    let home = PathBuf::from(
        std::env::var_os("SIDEKICKS_TEST_CODEX_HOME")
            .expect("SIDEKICKS_TEST_CODEX_HOME names a signed-in Codex home"),
    );
    let (relayed, relayed_starts) = run_parity_turn(
        &program,
        &home,
        CodexHomeKind::Account(test_provider_account_id()),
    )
    .await;
    let (local, _) = run_parity_turn(&program, &home, CodexHomeKind::CapabilityRead).await;
    assert!(!relayed.is_empty(), "the turn ran the command");
    assert!(relayed_starts > 0, "the command went through the relay");
    assert_eq!(relayed, local);
}

// The output and exit code of each command one turn on `home` ran, on a service of `kind`, and
// the process starts its relay forwarded: an account's selects the relay's environment, so its
// commands go through the relay, a capability read's runs them itself.
async fn run_parity_turn(
    program: &OsString,
    home: &Path,
    kind: CodexHomeKind,
) -> (Vec<(Option<String>, Option<i64>)>, u64) {
    let is_relayed = matches!(kind, CodexHomeKind::Account(_));
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let environment = ["HOME", "PATH"]
        .into_iter()
        .filter_map(|name| Some((name.to_owned(), std::env::var(name).ok()?)))
        .collect();
    let dependencies = test_codex_service_dependencies(
        folder.path(),
        Arc::new(TestCodexProgram {
            program: PathBuf::from(program),
            environment,
        }),
        Arc::new(UnheardEvents),
        Arc::new(UnrecordedChildren),
    );
    let socket = folder.path().join("codex.sock");
    let service = CodexService::new(
        CodexServiceHome {
            codex_home: home.to_owned(),
            kind,
        },
        CodexServiceSocket {
            path: socket.clone(),
            home_socket: socket,
        },
        CodexServiceKind::Account,
        dependencies,
        Vec::new(),
    );
    let (events, mut frames) = CodexDetachedFrames::new();
    let connection = service
        .open_detached_connection(events)
        .await
        .expect("the service starts and is dialed");
    let mut thread_start = json!({
        "cwd": folder.path(),
        "ephemeral": true,
        "approvalPolicy": "never",
        "sandbox": "danger-full-access",
    });
    if is_relayed {
        thread_start["environments"] = json!(compose_codex_relay_environments(folder.path()));
    }
    let started = connection
        .request(THREAD_START_METHOD, &thread_start)
        .await
        .expect("a conversation starts");
    let started: Value = serde_json::from_str(started.get()).expect("the reply is JSON");
    let prompt = format!(
        "Run exactly this shell command once, with no other command, then stop: {PARITY_COMMAND}"
    );
    connection
        .request(
            TURN_START_METHOD,
            &json!({
                "threadId": started["thread"]["id"],
                "input": [{ "type": "text", "text": prompt }],
            }),
        )
        .await
        .expect("the turn starts");
    let mut commands = Vec::new();
    let collected = tokio::time::timeout(PARITY_TURN_DEADLINE, async {
        while let Some((method, params)) = frames.recv().await {
            let params: Value = serde_json::from_str(params.get()).expect("the params are JSON");
            match method.as_str() {
                "item/completed" if params["item"]["type"] == "commandExecution" => {
                    commands.push((
                        params["item"]["aggregatedOutput"]
                            .as_str()
                            .map(str::to_owned),
                        params["item"]["exitCode"].as_i64(),
                    ));
                }
                "turn/completed" => return,
                _ => {}
            }
        }
    })
    .await;
    let relayed_starts = service
        .exec_relay()
        .map_or(0, |relay| relay.process_starts());
    service.stop().await;
    collected.expect("the turn ends within its deadline");
    (commands, relayed_starts)
}
