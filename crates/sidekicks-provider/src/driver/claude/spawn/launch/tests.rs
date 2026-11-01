use std::error::Error;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use secrecy::SecretString;
use sidekicks_contracts::provider::account::record::{CredentialGeneration, ProviderAccountId};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_platforms::{ProgramStart, Spawner};
use sidekicks_std::file::atomic_write::write_file_atomically;
use sidekicks_std::port_registration::PortRegistration;

use super::ClaudeProcessLauncher;
use crate::driver::child_records::UnrecordedChildren;
use crate::driver::claude::session::process::{
    ClaudeProcessEnd, ClaudeProcessLaunch, ClaudeProcessListener, ClaudeStreamFrame,
};
use crate::driver::claude::session::transport::inbound::ClaudeInboundRequestEvent;
use crate::driver::{
    AccountFoldersError, CurrentProviderAccount, ProviderAccountFolders, ProviderAccountReader,
};
use crate::process_registry::ProviderProcessRegistry;
use crate::runtime_binding::test_store::test_provider_account_id;

/// The token sealed for the test's account.
const SEALED_TOKEN: &str = "sk-ant-oat01-sealed-test-token-5d2e8b";

/// An accounts reader that answers only the token sealed for every account.
struct SealedToken;

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

    fn read_sealed_token(
        &self,
        _provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<Option<SecretString>, Box<dyn Error + Send + Sync>>> {
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
sh -c 'env > "$RECORD/command-environment"; cat <&"$CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR" > "$RECORD/command-descriptor" 2>&1'
"#;

// Killed by the token placed in the process's environment, which the model's command inherits,
// and by a descriptor left readable: a write end left open never lets the stand-in's read end, and
// a descriptor the command could read again would hand it the token. Also killed by a start that
// hands no token, where the stand-in reads none.
#[tokio::test(flavor = "multi_thread")]
async fn a_command_the_model_runs_on_a_token_account_reads_no_token() {
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let program = folder.path().join("claude");
    write_file_atomically(&program, STAND_IN, 0o755)
        .await
        .expect("the stand-in is written");
    let provider_accounts = PortRegistration::new("provider accounts");
    provider_accounts
        .register(Arc::new(SealedToken) as Arc<dyn ProviderAccountReader>)
        .expect("a new registration takes its port");
    let launcher = ClaudeProcessLauncher::new(
        Spawner::new(tokio::runtime::Handle::current()).expect("the spawner thread starts"),
        Arc::new(UnrecordedChildren),
        Arc::new(ProviderProcessRegistry::default()),
        Arc::new(provider_accounts),
        folder.path(),
    );
    let record = folder.path().to_string_lossy().into_owned();

    let process = launcher
        .start(
            ClaudeProcessLaunch {
                start: ProgramStart {
                    program,
                    leading_arguments: Vec::new(),
                },
                arguments: Vec::new(),
                environment: vec![
                    ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
                    ("RECORD".to_owned(), record),
                ],
                working_folder: PathBuf::from(folder.path()),
                provider_session_id: "conversation".to_owned(),
                provider_account_id: Some(test_provider_account_id()),
                token: None,
            },
            Arc::new(NoSession),
            None,
        )
        .await
        .expect("the process starts");
    let ended = tokio::time::timeout(Duration::from_secs(30), process.exited())
        .await
        .expect("the stand-in reads its token to the end and exits");

    assert!(ended.is_ok(), "{ended:?}");
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
