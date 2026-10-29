//! Claude Code's sign-out of one account's home: `claude auth logout` run on that account's
//! folders, so it removes the sign-in that home keeps and no other.

use std::io;
use std::path::PathBuf;
use std::process::Stdio;

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_platforms::{PathRules, read_child_exit, wrap_child_command};
use tokio::process::Command;

use crate::command_search::list_command_folders;
use crate::driver::ProviderAccountFolders;
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::account::ClaudeAccountLegs;
use crate::driver::claude::spawn::environment::{
    ClaudeAccountFolders, ClaudeProcessEnvironmentRequest, ClaudeProcessHome,
    compose_claude_process_environment, compose_claude_scratch_folder,
};
use crate::driver::contract::error::DriverError;
use crate::spawn_environment::SessionEnvironment;
use crate::spawned_version::{ResolvedProviderExecutable, resolve_provider_executable};

/// The arguments after the Claude Code command that sign its home out.
const CLAUDE_SIGN_OUT_ARGUMENTS: [&str; 2] = ["auth", "logout"];

/// Why Claude Code's sign-out did not finish.
#[derive(Debug, thiserror::Error)]
enum ClaudeSignOutError {
    /// The account's scratch folder, where the command runs, could not be made.
    #[error("the folder Claude Code's sign-out runs in could not be made")]
    WorkingFolder(#[source] io::Error),
    /// The command could not start.
    #[error("Claude Code's sign-out could not start")]
    Start(#[source] io::Error),
    /// The wait for its exit failed.
    #[error("Claude Code's sign-out's exit could not be waited for")]
    Wait(#[source] io::Error),
    /// It exited with a failure code.
    #[error("Claude Code's sign-out exited with code {exit_code}")]
    Failed {
        /// The exit code.
        exit_code: i64,
    },
    /// A signal ended it.
    #[error("Claude Code's sign-out was ended by {signal}")]
    Signaled {
        /// The signal's name.
        signal: String,
    },
}

/// Runs `claude auth logout` on `provider_account_id`'s `folders`, the build resolved in that
/// home's environment, in the account's scratch folder, and answers once it exited cleanly. Its
/// output is never read, since it may name the account. Fails with the resolve's error, as the
/// environment cannot be composed, and with `DriverError::Internal` when the command cannot start
/// or exits with a failure.
pub(super) async fn sign_out_claude_home(
    legs: &ClaudeAccountLegs,
    provider_account_id: ProviderAccountId,
    folders: ProviderAccountFolders,
) -> Result<(), DriverError> {
    let data_folder = legs.data_folder.to_string_lossy();
    let environment = compose_claude_process_environment(
        ClaudeProcessEnvironmentRequest {
            session: SessionEnvironment {
                base: &legs.base_environment,
                every_project_rows: &[],
                project_rows: &[],
                reserved_names: &legs.reserved_names,
                rules: PathRules::NATIVE,
            },
            deny_env_vars: &[],
            home: ClaudeProcessHome::Account {
                folders: &ClaudeAccountFolders::from(&folders),
                provider_account_id: &provider_account_id,
            },
            data_folder: &data_folder,
        },
        &[],
    )
    .map_err(|error| DriverError::Internal(Box::new(error)))?;
    let command = DESCRIPTOR
        .command_lookup(PathRules::NATIVE)
        .and_then(|lookup| lookup.names.first())
        .map_or_else(String::new, |name| (*name).to_owned());
    let search_folders = list_command_folders(&DESCRIPTOR, &legs.home_folder, &environment);
    let executable = resolve_provider_executable(
        &legs.command_search,
        &DESCRIPTOR.provider_id(),
        command,
        environment,
        search_folders,
    )
    .await?;
    let working_folder = compose_claude_scratch_folder(&data_folder, &provider_account_id);
    run_sign_out(legs, executable, working_folder)
        .await
        .map_err(|error| DriverError::Internal(Box::new(error)))
}

// Starts the sign-out on the spawner's thread as every child of the daemon starts, killed if the
// caller's bound drops the wait, and reads its exit.
async fn run_sign_out(
    legs: &ClaudeAccountLegs,
    executable: ResolvedProviderExecutable,
    working_folder: PathBuf,
) -> Result<(), ClaudeSignOutError> {
    tokio::fs::create_dir_all(&working_folder)
        .await
        .map_err(ClaudeSignOutError::WorkingFolder)?;
    let mut command = Command::new(executable.start.program);
    command
        .args(executable.start.leading_arguments)
        .args(CLAUDE_SIGN_OUT_ARGUMENTS)
        .env_clear()
        .envs(executable.environment)
        .current_dir(working_folder)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let daemon_pid = std::process::id();
    let mut child = legs
        .spawner
        .run(move || wrap_child_command(command, daemon_pid).spawn())
        .await
        .and_then(|spawned| spawned)
        .map_err(ClaudeSignOutError::Start)?;
    let status = child.wait().await.map_err(ClaudeSignOutError::Wait)?;
    if status.success() {
        return Ok(());
    }
    let exit = read_child_exit(&status, None);
    Err(match exit.signal_name {
        Some(signal) => ClaudeSignOutError::Signaled { signal },
        None => ClaudeSignOutError::Failed {
            exit_code: exit.exit_code,
        },
    })
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::Arc;

    use sidekicks_std::file::atomic_write::write_file_atomically;

    use crate::driver::ProviderAccountFolders;
    use crate::driver::claude::account::ClaudeAccountLegs;
    use crate::driver::contract::account::ProviderAccountLegs;
    use crate::driver::test_registry::test_driver_services;
    use crate::runtime_binding::test_store::test_provider_account_id;

    // The folders of `name`'s account under `root`.
    fn account_folders(root: &Path, name: &str) -> ProviderAccountFolders {
        ProviderAccountFolders {
            configuration_folder: root.join(name).join("config"),
            credential_store_folder: root.join(name).join("credentials"),
        }
    }

    // Killed by a sign-out run on the person's own home, which no account variable names, or on
    // any account's folders but the one named.
    #[tokio::test]
    async fn sign_out_runs_claude_auth_logout_in_the_named_home_and_no_other() {
        let root = tempfile::tempdir().expect("a scratch folder is made");
        let programs = root.path().join("programs");
        tokio::fs::create_dir_all(&programs)
            .await
            .expect("the programs folder is made");
        let record = root.path().join("sign-outs");
        write_file_atomically(
            &programs.join("claude"),
            format!(
                "#!/bin/sh\nprintf '%s|%s|%s\\n' \"$CLAUDE_CONFIG_DIR\" \
                 \"$CLAUDE_SECURESTORAGE_CONFIG_DIR\" \"$*\" >> '{}'\n",
                record.display()
            ),
            0o755,
        )
        .await
        .expect("the stand-in is written");
        let mut services = test_driver_services();
        services.data_folder = root.path().join("data");
        services.home_folder = root.path().join("home");
        services.base_environment = Arc::from([(
            "PATH".to_owned(),
            format!("{}:/usr/bin:/bin", programs.display()),
        )]);
        let legs = ClaudeAccountLegs::new(&services);
        let named = account_folders(root.path(), "one");

        legs.sign_out_home(test_provider_account_id(), named.clone())
            .await
            .expect("the sign-out exits cleanly");

        let recorded = tokio::fs::read_to_string(&record)
            .await
            .expect("the stand-in ran");
        assert_eq!(
            recorded,
            format!(
                "{}|{}|auth logout\n",
                named.configuration_folder.display(),
                named.credential_store_folder.display()
            )
        );
    }
}
