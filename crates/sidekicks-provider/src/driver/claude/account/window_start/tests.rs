use std::path::Path;
use std::sync::{Arc, Weak};

use rstest::rstest;
use secrecy::SecretString;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_platforms::real_path;
use sidekicks_std::file::atomic_write::write_file_atomically;

use super::{CLAUDE_WINDOW_TURN_ARGUMENTS, CLAUDE_WINDOW_TURN_FOLDER, CLAUDE_WINDOW_TURN_LINE};
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::account::test_account_legs;
use crate::driver::claude::mcp::organization::has_readable_managed_mcp_file;
use crate::driver::claude::spawn::arguments::CLAUDE_NO_MCP_SERVERS;
use crate::driver::contract::account::{
    ProviderObservation, ProviderTokenLimitsLegs, ProviderWindowTurnLegs, WindowTurnAnswer,
};
use crate::driver::test_registry::{TestProviderAccounts, test_driver_services};
use crate::driver::{CurrentProviderAccount, ProviderAccountFolders, ProviderAccountReader};
use crate::runtime_binding::test_store::test_provider_account_id;

/// The token a pasted-token read hands the turn.
const PASTED_TOKEN: &str = "sk-ant-oat01-window-turn-test-token-5d2e";

/// The model the stand-in's start names.
const RESOLVED_MODEL: &str = "claude-haiku-5-5";

// A stand-in for Claude Code: it records its command line one argument a line, its homes, its
// folder and any token handed on its pipe; reads its input to the end, as a
// line given beside a piped input does; writes a session file into its configuration folder unless
// told to keep none; then writes its start, a `rate_limit_event` and its `result`, an error one
// where `is_error`.
fn stand_in(record: &Path, is_error: bool) -> String {
    format!(
        r#"#!/bin/sh
printf '%s\n' "$@" > '{record}.arguments'
handed=''
if [ -n "$CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR" ]; then
  handed=$(cat <&"$CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR")
fi
printf '%s\n%s\n%s\n%s\n' "$CLAUDE_CONFIG_DIR" "$CLAUDE_SECURESTORAGE_CONFIG_DIR" "$PWD" \
  "$handed" > '{record}.homes'
cat > /dev/null
kept=yes
for argument in "$@"; do
  [ "$argument" = '--no-session-persistence' ] && kept=no
done
if [ "$kept" = yes ]; then
  mkdir -p "$CLAUDE_CONFIG_DIR/projects/window" "$CLAUDE_SECURESTORAGE_CONFIG_DIR/projects"
  printf '{{}}\n' > "$CLAUDE_CONFIG_DIR/projects/window/session.jsonl"
  printf '{{}}\n' > "$CLAUDE_SECURESTORAGE_CONFIG_DIR/projects/session.jsonl"
fi
printf '%s\n' '{{"type":"system","subtype":"init","model":"{RESOLVED_MODEL}","session_id":"s"}}'
printf '%s\n' '{{"type":"rate_limit_event","rate_limit_info":{{"unifiedWindows":{{'\
'"five_hour":{{"utilization":0.25,"resetsAt":1790125200}},'\
'"seven_day":{{"utilization":0.5,"resetsAt":1790524800}}}}}},"session_id":"s"}}'
printf '%s\n' '{{"type":"result","subtype":"success","is_error":{is_error},"result":"ok",'\
'"usage":{{"input_tokens":395,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,'\
'"output_tokens":51}},"session_id":"s"}}'
"#,
        record = record.display()
    )
}

// Killed by `--no-session-persistence` dropped or any other change to the command line (the
// recorded line differs, and the stand-in keeps a session file in the account's store), by the
// turn run in the account's own configuration home, on another store or in a project folder, by
// its input left open (the stand-in never ends), by the token left off the pipe, by the event's
// windows dropped, by the counts dropped, by an error turn read as a spend, by the flag that loads
// no MCP server dropped, and by the denial of every MCP tool dropped, which an administrator's MCP
// file would otherwise let in.
#[rstest]
#[case::a_window_start(false, false)]
#[case::a_refused_window_start(false, true)]
#[case::a_pasted_token_s_read(true, false)]
#[case::a_refused_pasted_token_s_read(true, true)]
#[tokio::test(flavor = "multi_thread")]
async fn the_smallest_turn_runs_its_one_command_line_on_the_account_s_store_and_keeps_nothing(
    #[case] is_token_read: bool,
    #[case] is_error: bool,
) {
    let scratch = tempfile::tempdir().expect("a scratch folder is made");
    // The folder as the stand-in's shell reads its own folder, past any link.
    let root = real_path(scratch.path()).expect("the scratch folder resolves");
    let programs = root.join("programs");
    tokio::fs::create_dir_all(&programs)
        .await
        .expect("the programs folder is made");
    let record = root.join("record");
    write_file_atomically(&programs.join("claude"), stand_in(&record, is_error), 0o755)
        .await
        .expect("the stand-in is written");
    let mut services = test_driver_services();
    services.data_folder = root.join("data");
    services.home_folder = root.join("home");
    services.base_environment = Arc::from([(
        "PATH".to_owned(),
        format!("{}:/usr/bin:/bin", programs.display()),
    )]);
    services
        .ports
        .provider_accounts
        .register(Arc::new(TestProviderAccounts::new(
            CurrentProviderAccount::NoneRegistered,
        )) as Arc<dyn ProviderAccountReader>)
        .expect("the accounts port is registered once");
    let legs = test_account_legs(&services, Weak::new());
    let folders = ProviderAccountFolders {
        configuration_folder: root.join("account"),
        credential_store_folder: root.join("account").join("store"),
    };
    tokio::fs::create_dir_all(&folders.credential_store_folder)
        .await
        .expect("the account's store is made");

    let spend = if is_token_read {
        let reading = legs
            .read_token_limits(
                &test_provider_account_id(),
                &folders,
                &SecretString::from(PASTED_TOKEN),
            )
            .await
            .expect("the read answers");
        let ProviderObservation::Figures(figures) = reading.observation else {
            panic!(
                "the event's windows are the reading: {:?}",
                reading.observation
            );
        };
        let mut limits: Vec<_> = figures
            .windows
            .iter()
            .map(|window| (window.limit_id.as_str(), window.used_percent))
            .collect();
        limits.sort_by(|left, right| left.0.cmp(right.0));
        assert_eq!(limits, [("session", 25.0), ("weekly_all", 50.0)]);
        reading.spend
    } else {
        match legs
            .start_window(test_provider_account_id(), folders.clone())
            .await
            .expect("the turn answers")
        {
            WindowTurnAnswer::Spent(spends) => {
                let [spend] = spends.as_slice() else {
                    panic!("one request spends: {spends:?}");
                };
                Some(spend.clone())
            }
            WindowTurnAnswer::Refused => None,
        }
    };

    match spend {
        Some(spend) => {
            assert!(!is_error, "an error turn spends nothing");
            assert_eq!(
                spend.model_id.as_ref().map(FreeFormText::as_str),
                Some(RESOLVED_MODEL)
            );
            assert_eq!(spend.input_tokens.map(SafeInt::get), Some(395));
            assert_eq!(spend.output_tokens.map(SafeInt::get), Some(51));
        }
        None => assert!(is_error, "a turn that ended well spends"),
    }
    let arguments = tokio::fs::read_to_string(record.with_extension("arguments"))
        .await
        .expect("the stand-in recorded its command line");
    let no_mcp_servers =
        (!has_readable_managed_mcp_file(DESCRIPTOR.managed_settings_folder().as_deref()).await)
            .then_some(CLAUDE_NO_MCP_SERVERS);
    let expected: String = CLAUDE_WINDOW_TURN_ARGUMENTS
        .iter()
        .copied()
        .chain(no_mcp_servers)
        .chain([CLAUDE_WINDOW_TURN_LINE, "--settings"])
        .flat_map(|argument| [argument, "\n"])
        .collect();
    assert_eq!(
        arguments
            .lines()
            .any(|argument| argument == "--strict-mcp-config"),
        no_mcp_servers.is_some(),
        "the turn loads no MCP server unless an administrator's file does"
    );
    let (named, settings_file) = arguments
        .trim_end_matches('\n')
        .rsplit_once('\n')
        .expect("the command line ends in its settings file");
    assert_eq!(format!("{named}\n"), expected);
    assert!(
        Path::new(settings_file).starts_with(&services.data_folder),
        "the settings are read from a file of the daemon's own: {settings_file}"
    );
    let lines: Vec<&str> = arguments.lines().collect();
    assert!(
        lines
            .windows(2)
            .any(|pair| pair == ["--disallowedTools", "mcp__*"]),
        "the turn denies every MCP tool, an administrator's servers among them: {lines:?}"
    );
    let homes = tokio::fs::read_to_string(record.with_extension("homes"))
        .await
        .expect("the stand-in recorded its homes");
    let homes: Vec<&str> = homes.split('\n').collect();
    let turns_folder = CLAUDE_WINDOW_TURN_FOLDER
        .iter()
        .fold(services.data_folder.clone(), |folder, name| {
            folder.join(name)
        });
    assert!(
        Path::new(homes[0]).starts_with(&turns_folder),
        "the turn's configuration home is its own folder: {}",
        homes[0]
    );
    assert_eq!(Path::new(homes[1]), folders.credential_store_folder);
    let working_folder = Path::new(homes[2]);
    assert!(
        working_folder.starts_with(&services.data_folder)
            && !working_folder.starts_with(&turns_folder),
        "the turn runs in the daemon's empty folder: {}",
        homes[2]
    );
    assert_eq!(homes[3], if is_token_read { PASTED_TOKEN } else { "" });
    let mut left = tokio::fs::read_dir(&turns_folder)
        .await
        .expect("the turns' folder stays");
    assert!(
        left.next_entry()
            .await
            .expect("the turns' folder lists")
            .is_none(),
        "the turn's own folder is removed after it"
    );
    let mut store = tokio::fs::read_dir(&folders.credential_store_folder)
        .await
        .expect("the store lists");
    assert!(
        store.next_entry().await.expect("the store lists").is_none(),
        "the turn keeps no session file in the account's store"
    );
}
