use std::error::Error;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use secrecy::SecretString;
use serde_json::Value;
use sidekicks_contracts::provider::account::record::{
    CredentialGeneration, ProviderAccountId, ProviderAuthMode,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_platforms::{ProgramStart, Spawner, has_file_mode};
use sidekicks_std::file::atomic_write::write_file_atomically;
use sidekicks_std::port_registration::PortRegistration;

use super::{ClaudeLaunchError, ClaudeProcessLauncher};
use crate::bearer_token::BearerToken;
use crate::bounded_poll::poll_until;
use crate::driver::child_records::UnrecordedChildren;
use crate::driver::claude::session::process::account::ClaudeProcessAccount;
use crate::driver::claude::session::process::{
    ClaudeProcessEnd, ClaudeProcessLaunch, ClaudeProcessListener, ClaudeStreamFrame,
};
use crate::driver::claude::session::transport::inbound::ClaudeInboundRequestEvent;
use crate::driver::claude::spawn::launch::listed_commands::read_claude_session_commands;
use crate::driver::claude::spawn::settings::ClaudeSpawnSettings;
use crate::driver::claude::spawn::settings::private_file::compose_claude_settings_folder;
use crate::driver::{
    AccountFoldersError, CurrentProviderAccount, ProviderAccountFolders, ProviderAccountReader,
};
use crate::pricing::receiver::TelemetryTarget;
use crate::process_registry::ProviderProcessRegistry;
use crate::runtime_binding::test_store::test_provider_account_id;
use crate::spawned_version::ResolvedProviderExecutable;

/// The token sealed for the test's account.
const SEALED_TOKEN: &str = "sk-ant-oat01-sealed-test-token-5d2e8b";

/// An accounts reader answering every account's sign-in as `mode` and the token sealed for it,
/// counting the token reads.
struct SealedToken {
    mode: ProviderAuthMode,
    tokens_read: AtomicUsize,
}

impl ProviderAccountReader for SealedToken {
    fn resolve_account_folders(
        &self,
        _provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<ProviderAccountFolders, AccountFoldersError>> {
        async { Err(AccountFoldersError::NotFound) }.boxed()
    }

    fn current_account(
        &self,
        _provider_id: ProviderId,
    ) -> BoxFuture<'_, Result<CurrentProviderAccount, Box<dyn Error + Send + Sync>>> {
        async { Ok(CurrentProviderAccount::NoneRegistered) }.boxed()
    }

    fn read_credential_generation(
        &self,
        _provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<CredentialGeneration, Box<dyn Error + Send + Sync>>> {
        async { Err("no generation in this test".into()) }.boxed()
    }

    fn read_observed_auth_mode(
        &self,
        _provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<Option<ProviderAuthMode>, Box<dyn Error + Send + Sync>>> {
        let mode = self.mode;
        async move { Ok(Some(mode)) }.boxed()
    }

    fn read_sealed_token(
        &self,
        _provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<Option<SecretString>, Box<dyn Error + Send + Sync>>> {
        self.tokens_read.fetch_add(1, Ordering::SeqCst);
        async { Ok(Some(SecretString::from(SEALED_TOKEN))) }.boxed()
    }
}

struct NoSession;

impl ClaudeProcessListener for NoSession {
    fn take_frame(&self, _frame: ClaudeStreamFrame) {}

    fn take_request(&self, _event: ClaudeInboundRequestEvent) {}

    fn take_exit(&self, _end: ClaudeProcessEnd) {}

    fn is_turn_ending(&self, _frame: &ClaudeStreamFrame) -> bool {
        true
    }
}

// A stand-in that reads its token from the descriptor its environment names, as Claude Code does,
// keeps that descriptor open, and runs a command as the model would, which records its whole
// environment and what it reads from the same descriptor number.
const STAND_IN: &str = r#"#!/bin/sh
handed=$(cat <&"$CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR")
printf '%s' "$handed" > "$RECORD/handed"
sh -c 'env > "$RECORD/command-environment"; '\
'cat <&"$CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR" > "$RECORD/command-descriptor" 2>&1'
"#;

// Starts the stand-in through a launcher whose accounts answer every sign-in as `mode`, for a
// launch naming an account and carrying no token, and waits for it to exit; answers the folder
// it recorded in and the accounts reader.
async fn run_stand_in(mode: ProviderAuthMode) -> (tempfile::TempDir, Arc<SealedToken>) {
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let program = folder.path().join("claude");
    write_file_atomically(&program, STAND_IN, 0o755)
        .await
        .expect("the stand-in is written");
    let accounts = Arc::new(SealedToken {
        mode,
        tokens_read: AtomicUsize::new(0),
    });
    let launcher = compose_launcher(
        folder.path(),
        Arc::clone(&accounts) as Arc<dyn ProviderAccountReader>,
        None,
    );

    let process = launcher
        .start(
            compose_launch(folder.path(), program),
            Arc::new(NoSession),
            None,
        )
        .await
        .expect("the process starts");
    let ended = tokio::time::timeout(Duration::from_secs(30), process.exited())
        .await
        .expect("the stand-in reads its token to the end and exits");
    assert!(ended.is_ok(), "{ended:?}");
    (folder, accounts)
}

// A launcher whose data folder is `folder`, reading accounts through `accounts` and with `target`
// registered where given.
fn compose_launcher(
    folder: &Path,
    accounts: Arc<dyn ProviderAccountReader>,
    target: Option<TelemetryTarget>,
) -> ClaudeProcessLauncher {
    let provider_accounts = PortRegistration::new("provider accounts");
    provider_accounts
        .register(accounts)
        .expect("a new registration takes its port");
    let telemetry_target = PortRegistration::new("telemetry target");
    if let Some(target) = target {
        telemetry_target
            .register(Arc::new(target))
            .expect("a new registration takes its port");
    }
    ClaudeProcessLauncher::new(
        Spawner::new(tokio::runtime::Handle::current()).expect("the spawner thread starts"),
        Arc::new(UnrecordedChildren),
        Arc::new(ProviderProcessRegistry::default()),
        Arc::new(provider_accounts),
        Arc::new(telemetry_target),
        folder,
    )
}

// A launch of `program` on the test's account with a short process's settings, recording into
// `folder`.
fn compose_launch(folder: &Path, program: PathBuf) -> ClaudeProcessLaunch {
    ClaudeProcessLaunch {
        start: ProgramStart {
            program,
            leading_arguments: Vec::new(),
        },
        arguments: Vec::new(),
        settings: ClaudeSpawnSettings::short_process(false),
        environment: vec![
            ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
            ("RECORD".to_owned(), folder.to_string_lossy().into_owned()),
        ],
        working_folder: PathBuf::from(folder),
        provider_session_id: "conversation".to_owned(),
        account: ClaudeProcessAccount::new(Some(test_provider_account_id())),
        token: None,
    }
}

// A stand-in that records its arguments and a copy of the file its last one names, says it has,
// then waits on its input until the daemon closes it.
const SETTINGS_STAND_IN: &str = r#"#!/bin/sh
printf '%s\n' "$@" > "$RECORD/arguments"
for last; do :; done
cp "$last" "$RECORD/settings"
: > "$RECORD/recorded"
cat > /dev/null
"#;

// Killed by the document inline on the command line, by the token in an argument, by the file
// left after the process's end, by the file's mode left to the umask, and by the person's hooks
// turned off on a short process that does not ask for it.
#[tokio::test(flavor = "multi_thread")]
async fn a_process_reads_its_settings_from_a_private_file_gone_at_its_end() {
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let program = folder.path().join("claude");
    write_file_atomically(&program, SETTINGS_STAND_IN, 0o755)
        .await
        .expect("the stand-in is written");
    let bearer = Arc::new(BearerToken::mint().expect("a token mints"));
    let token = bearer.text().to_owned();
    let launcher = compose_launcher(
        folder.path(),
        Arc::new(SealedToken {
            mode: ProviderAuthMode::OauthSubscription,
            tokens_read: AtomicUsize::new(0),
        }),
        Some(TelemetryTarget::new(43_210, bearer)),
    );

    let process = launcher
        .start(
            compose_launch(folder.path(), program),
            Arc::new(NoSession),
            None,
        )
        .await
        .expect("the process starts");
    let recorded = folder.path().join("recorded");
    poll_until(|| recorded.exists(), |is_recorded| *is_recorded).await;

    let arguments = std::fs::read_to_string(folder.path().join("arguments"))
        .expect("the stand-in recorded its arguments");
    let arguments: Vec<&str> = arguments.lines().collect();
    let [.., flag, path] = arguments.as_slice() else {
        panic!("the process has its settings arguments: {arguments:?}");
    };
    assert_eq!(*flag, "--settings");
    let path = Path::new(path);
    assert_eq!(
        path.parent(),
        Some(compose_claude_settings_folder(folder.path()).as_path())
    );
    assert!(
        !arguments.iter().any(|argument| argument.contains(&token)),
        "no argument carries the token"
    );
    assert!(
        has_file_mode(path, 0o600).expect("the settings file is there while the process runs"),
        "the file is private to the daemon's user"
    );
    let settings: Value = serde_json::from_str(
        &std::fs::read_to_string(folder.path().join("settings"))
            .expect("the stand-in copied the file"),
    )
    .expect("the file holds the document");
    assert_eq!(
        settings["env"]["OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"],
        "http://127.0.0.1:43210/telemetry/claude/v1/logs"
    );
    assert_eq!(
        settings["env"]["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"],
        "http://127.0.0.1:43210/telemetry/claude/v1/traces"
    );
    assert_eq!(
        settings["env"]["OTEL_EXPORTER_OTLP_HEADERS"],
        format!("authorization=Bearer {token}")
    );
    assert_eq!(settings["otelHeadersHelper"], "");
    assert_eq!(settings["disableAllHooks"], Value::Null);

    process.stop(Duration::from_secs(10), None).await;
    let ended = tokio::time::timeout(Duration::from_secs(30), process.exited())
        .await
        .expect("the stand-in exits once its input closes");
    assert!(ended.is_ok(), "{ended:?}");
    poll_until(|| path.exists(), |is_there| !*is_there).await;
}

// Killed by the file's guard made after the spawn, which leaves the written file behind when the
// program cannot start.
#[tokio::test(flavor = "multi_thread")]
async fn a_start_whose_program_is_missing_leaves_no_settings_file() {
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let launcher = compose_launcher(
        folder.path(),
        Arc::new(SealedToken {
            mode: ProviderAuthMode::OauthSubscription,
            tokens_read: AtomicUsize::new(0),
        }),
        None,
    );

    let started = launcher
        .start(
            compose_launch(folder.path(), folder.path().join("missing")),
            Arc::new(NoSession),
            None,
        )
        .await;

    assert!(
        matches!(started, Err(ClaudeLaunchError::Spawn(_))),
        "the start fails at its spawn"
    );
    let settings_folder = compose_claude_settings_folder(folder.path());
    poll_until(
        || {
            std::fs::read_dir(&settings_folder)
                .expect("the settings folder was made before the spawn")
                .count()
        },
        |files| *files == 0,
    )
    .await;
}

// Killed by the token placed in the process's environment, which the model's command inherits,
// and by a descriptor left readable: a write end left open never lets the stand-in's read end, and
// a descriptor the command could read again would hand it the token. Also killed by a start that
// hands no token, where the stand-in reads none.
#[tokio::test(flavor = "multi_thread")]
async fn a_command_the_model_runs_on_a_token_account_reads_no_token() {
    let (folder, _accounts) = run_stand_in(ProviderAuthMode::OauthToken).await;

    let recorded =
        |name| std::fs::read_to_string(folder.path().join(name)).expect("the stand-in recorded it");
    assert_eq!(
        recorded("handed"),
        SEALED_TOKEN,
        "the process is handed its token"
    );
    let command_environment = recorded("command-environment");
    assert!(
        command_environment.contains("CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR="),
        "the command's environment is recorded whole: {command_environment}"
    );
    assert!(
        !command_environment.contains(SEALED_TOKEN),
        "the command's environment holds no token"
    );
    assert!(
        !recorded("command-descriptor").contains(SEALED_TOKEN),
        "the command reads no token from the inherited descriptor"
    );
}

// Killed by the sign-in gate dropped, which reads the daemon's keychain for an account that signs
// in through its own store and hands it a token it does not sign in with.
#[tokio::test(flavor = "multi_thread")]
async fn a_store_account_s_start_reads_no_keychain() {
    let (folder, accounts) = run_stand_in(ProviderAuthMode::OauthSubscription).await;

    assert_eq!(accounts.tokens_read.load(Ordering::SeqCst), 0);
    let command_environment = std::fs::read_to_string(folder.path().join("command-environment"))
        .expect("the stand-in recorded it");
    assert!(
        !command_environment.contains("CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR="),
        "no token pipe is named: {command_environment}"
    );
}

// A stand-in that copies the file its last argument names, then answers each control request
// with an empty success.
const INITIALIZE_STAND_IN: &str = r#"#!/bin/sh
for last; do :; done
cp "$last" "$RECORD/settings"
while read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
  printf '{"type":"control_response","response":{"subtype":"success",'\
'"request_id":"%s","response":{}}}\n' "$id"
done
"#;

// Killed by the command-list read started with the person's hooks on, which runs their
// `SessionStart` hook on every palette read.
#[tokio::test(flavor = "multi_thread")]
async fn the_command_list_read_turns_the_persons_hooks_off() {
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let program = folder.path().join("claude");
    write_file_atomically(&program, INITIALIZE_STAND_IN, 0o755)
        .await
        .expect("the stand-in is written");
    let launcher = compose_launcher(
        folder.path(),
        Arc::new(SealedToken {
            mode: ProviderAuthMode::OauthSubscription,
            tokens_read: AtomicUsize::new(0),
        }),
        None,
    );
    let executable = ResolvedProviderExecutable {
        requested_command: "claude".to_owned(),
        resolved_executable_path: program.clone(),
        start: ProgramStart {
            program,
            leading_arguments: Vec::new(),
        },
        environment: vec![
            ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
            (
                "RECORD".to_owned(),
                folder.path().to_string_lossy().into_owned(),
            ),
        ],
    };

    let commands = tokio::time::timeout(
        Duration::from_secs(30),
        read_claude_session_commands(
            &launcher,
            &executable,
            folder.path().to_path_buf(),
            test_provider_account_id(),
            false,
        ),
    )
    .await
    .expect("the read ends");

    assert!(commands.is_ok(), "{commands:?}");
    let settings: Value = serde_json::from_str(
        &std::fs::read_to_string(folder.path().join("settings"))
            .expect("the stand-in copied the file"),
    )
    .expect("the file holds the document");
    assert_eq!(settings["disableAllHooks"], true);
}
