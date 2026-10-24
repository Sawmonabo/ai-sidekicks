//! The one-shot pass, run against a stand-in for Codex's program.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use rstest::rstest;
use serde_json::Value;
use sidekicks_platforms::{LeftoverSweep, replace_file_atomically};

use super::locked_down_config;
use crate::provider::driver::codex::lifecycle::naming::name_in_one_shot;
use crate::provider::driver::codex::service::home::{
    CodexHomeKind, CodexServiceHome, CodexServiceKind,
};
use crate::provider::driver::codex::service::supervisor::test_service::{
    TestCodexProgram, UnheardEvents, script_codex_service, test_codex_service_dependencies,
};
use crate::provider::driver::codex::service::supervisor::{CodexService, CodexServiceSocket};

// A stand-in for Codex's program in `folder`: `codex mcp list --json` prints `listing` and exits
// with `list_exit`; any other call writes its arguments, one a line, to `arguments` and fails.
fn write_stand_in(folder: &Path, listing: &str, list_exit: u8, arguments: &Path) -> PathBuf {
    let program = folder.join("codex");
    let body = format!(
        "#!/bin/sh\nif [ \"$1\" = mcp ]; then printf '%s' '{listing}'; exit {list_exit}; fi\n\
         for argument in \"$@\"; do printf '%s\\n' \"$argument\" >> '{}'; done\nexit 1\n",
        arguments.display()
    );
    replace_file_atomically(&program, body.as_bytes(), 0o755, LeftoverSweep::Unswept)
        .expect("the stand-in is written");
    program
}

// A service whose program is `program`, with its folders under `folder`.
fn service_running(folder: &Path, program: PathBuf) -> Arc<CodexService> {
    let dependencies = test_codex_service_dependencies(
        folder,
        Arc::new(TestCodexProgram {
            program,
            environment: Vec::new(),
        }),
        Arc::new(UnheardEvents),
    );
    let socket = folder.join("codex.sock");
    script_codex_service(
        CodexServiceHome {
            codex_home: folder.join("home"),
            provider_account_id: None,
            kind: CodexHomeKind::Account,
        },
        CodexServiceSocket {
            path: socket.clone(),
            home_socket: socket,
        },
        CodexServiceKind::Account,
        dependencies,
    )
    .0
}

// The config the `-c` arguments before `exec` set, each value read back as TOML.
fn read_overrides(arguments: &[String]) -> Value {
    let exec_at = arguments
        .iter()
        .position(|argument| argument == "exec")
        .expect("the pass runs `exec`");
    let overrides: serde_json::Map<String, Value> = arguments[..exec_at]
        .chunks(2)
        .map(|pair| {
            assert_eq!(pair[0], "-c", "only overrides come before `exec`");
            let (key, value) = pair[1].split_once('=').expect("an override is key=value");
            let read: toml::Table =
                toml::from_str(&format!("value = {value}")).expect("the value is TOML");
            (
                key.to_owned(),
                serde_json::to_value(&read["value"]).expect("a TOML value is JSON"),
            )
        })
        .collect();
    Value::Object(overrides)
}

// Killed by skipping the server list: `exec` would run with no server named in the failing case,
// and with the listed servers left on in the other.
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
    let program = write_stand_in(folder.path(), listing, list_exit, &arguments_file);
    let service = service_running(folder.path(), program);

    let named = name_in_one_shot(&service, "Name this.").await;

    if is_listed {
        assert_eq!(
            named.expect("the pass ran"),
            None,
            "the stand-in names nothing"
        );
        let arguments: Vec<String> = std::fs::read_to_string(&arguments_file)
            .expect("`exec` ran")
            .lines()
            .map(str::to_owned)
            .collect();
        assert_eq!(read_overrides(&arguments), locked_down_config());
    } else {
        assert!(named.is_err(), "an unread list fails the pass");
        assert!(!arguments_file.exists(), "`exec` never ran");
    }
}
