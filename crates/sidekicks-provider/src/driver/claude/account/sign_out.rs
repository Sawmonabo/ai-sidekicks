//! Claude Code's sign-out of one account's home: `claude auth logout` run on that account's
//! folders, so it removes the sign-in that home keeps and no other. The running daemon's account
//! legs and a helper mode's, run with no daemon serving, both sign a home out through it.

use std::io;
use std::path::PathBuf;

use sidekicks_platforms::Spawner;

use crate::driver::ProviderAccountFolders;
use crate::driver::claude::account::ClaudeAccountProcessSources;
use crate::driver::claude::spawn::environment::{
    ClaudeAccountFolders, ClaudeProcessHome, compose_claude_scratch_folder,
};
use crate::driver::claude::spawn::one_shot_command::{ClaudeOneShotError, run_claude_one_shot};
use crate::driver::contract::error::DriverError;
use crate::spawned_version::ResolvedProviderExecutable;

/// The arguments after the Claude Code command that sign its home out.
const CLAUDE_SIGN_OUT_ARGUMENTS: [&str; 2] = ["auth", "logout"];

/// Why Claude Code's sign-out did not finish.
#[derive(Debug, thiserror::Error)]
enum ClaudeSignOutError {
    /// The home's scratch folder, where the command runs, could not be made.
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

/// Runs `claude auth logout` on an account's `folders` from `sources`, the build resolved in that
/// home's environment, in the home's scratch folder, and answers once it exited cleanly. Its
/// output is never read, since it may name the account. Fails with the resolve's error, as the
/// environment cannot be composed, and with `DriverError::Internal` when the command cannot start
/// or exits with a failure.
pub(super) async fn sign_out_claude_home(
    sources: &ClaudeAccountProcessSources,
    folders: ProviderAccountFolders,
) -> Result<(), DriverError> {
    let executable = sources
        .resolve_build_on(
            ClaudeProcessHome::Account {
                folders: &ClaudeAccountFolders::from(&folders),
            },
            &[],
        )
        .await?;
    let working_folder = compose_claude_scratch_folder(
        &sources.0.data_folder.to_string_lossy(),
        &folders.configuration_folder,
    );
    run_sign_out(&sources.0.spawner, &executable, working_folder)
        .await
        .map_err(|error| DriverError::Internal(Box::new(error)))
}

// Runs the sign-out in `working_folder`, made first, killed if the caller's bound drops the wait,
// and reads its exit.
async fn run_sign_out(
    spawner: &Spawner,
    executable: &ResolvedProviderExecutable,
    working_folder: PathBuf,
) -> Result<(), ClaudeSignOutError> {
    tokio::fs::create_dir_all(&working_folder)
        .await
        .map_err(ClaudeSignOutError::WorkingFolder)?;
    let ended = run_claude_one_shot(
        spawner,
        executable,
        &CLAUDE_SIGN_OUT_ARGUMENTS,
        &working_folder,
        false,
        false,
    )
    .await
    .map_err(|error| match error {
        ClaudeOneShotError::Start(error) => ClaudeSignOutError::Start(error),
        ClaudeOneShotError::Wait(error) => ClaudeSignOutError::Wait(error),
    })?;
    if ended.is_success() {
        return Ok(());
    }
    Err(match ended.exit.signal_name {
        Some(signal) => ClaudeSignOutError::Signaled { signal },
        None => ClaudeSignOutError::Failed {
            exit_code: ended.exit.exit_code,
        },
    })
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::{Arc, Weak};

    use sidekicks_std::file::atomic_write::write_file_atomically;

    use crate::driver::claude::account::helper_mode::ClaudeHelperModeLegs;
    use crate::driver::claude::account::test_account_legs;
    use crate::driver::claude::spawn::settings::compose_claude_export_off_settings;
    use crate::driver::contract::account::{HelperModeAccountLegs, ProviderAccountLegs};
    use crate::driver::helper_mode_services_over;
    use crate::driver::test_registry::test_driver_services;
    use crate::driver::{DriverServices, ProviderAccountFolders};
    use crate::runtime_binding::test_store::test_provider_account_id;

    // The folders of `name`'s account under `root`.
    fn account_folders(root: &Path, name: &str) -> ProviderAccountFolders {
        ProviderAccountFolders {
            configuration_folder: root.join(name).join("config"),
            credential_store_folder: root.join(name).join("credentials"),
        }
    }

    // The driver's services over a stand-in `claude` under `root` that appends its configuration
    // and store folders and its arguments to `root`'s `sign-outs` record, and exits 1 in a home
    // whose configuration folder holds a `refuse` file.
    async fn services_over_stand_in(root: &Path) -> DriverServices {
        let programs = root.join("programs");
        tokio::fs::create_dir_all(&programs)
            .await
            .expect("the programs folder is made");
        write_file_atomically(
            &programs.join("claude"),
            format!(
                "#!/bin/sh\nprintf '%s|%s|%s\\n' \"$CLAUDE_CONFIG_DIR\" \
                 \"$CLAUDE_SECURESTORAGE_CONFIG_DIR\" \"$*\" >> '{}'\n\
                 [ -e \"$CLAUDE_CONFIG_DIR/refuse\" ] && exit 1\nexit 0\n",
                root.join("sign-outs").display()
            ),
            0o755,
        )
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
    }

    // What the stand-in recorded for `folders`' home: its configuration and store folders and
    // `auth logout` after the export-off settings, one line a run.
    fn signed_out_line(folders: &ProviderAccountFolders) -> String {
        format!(
            "{}|{}|--settings {} auth logout\n",
            folders.configuration_folder.display(),
            folders.credential_store_folder.display(),
            compose_claude_export_off_settings()
        )
    }

    // Killed by a sign-out run on the person's own home, which no account variable names, or on
    // any account's folders but the one named.
    #[tokio::test]
    async fn sign_out_runs_claude_auth_logout_in_the_named_home_and_no_other() {
        let root = tempfile::tempdir().expect("a scratch folder is made");
        let services = services_over_stand_in(root.path()).await;
        let legs = test_account_legs(&services, Weak::new());
        let named = account_folders(root.path(), "one");

        legs.sign_out_home(test_provider_account_id(), named.clone())
            .await
            .expect("the sign-out exits cleanly");

        let recorded = tokio::fs::read_to_string(root.path().join("sign-outs"))
            .await
            .expect("the stand-in ran");
        assert_eq!(recorded, signed_out_line(&named));
    }

    // A helper mode's legs sign the named home out with `claude auth logout` in that home, and a
    // run that exits 1 answers an error. Killed by the run made in another home and by a failed
    // exit answered as a sign-out.
    #[tokio::test]
    async fn the_helper_mode_signs_a_claude_code_home_out() {
        let root = tempfile::tempdir().expect("a scratch folder is made");
        let services = services_over_stand_in(root.path()).await;
        let legs = ClaudeHelperModeLegs::new(&helper_mode_services_over(&services));
        let named = account_folders(root.path(), "one");
        let refusing = account_folders(root.path(), "two");
        tokio::fs::create_dir_all(&refusing.configuration_folder)
            .await
            .expect("the refusing home is made");
        tokio::fs::write(refusing.configuration_folder.join("refuse"), "")
            .await
            .expect("the refusal is planted");

        legs.sign_out_home(test_provider_account_id(), named.clone())
            .await
            .expect("the sign-out exits cleanly");
        legs.sign_out_home(test_provider_account_id(), refusing.clone())
            .await
            .expect_err("a sign-out that exits 1 is no sign-out");

        let recorded = tokio::fs::read_to_string(root.path().join("sign-outs"))
            .await
            .expect("the stand-in ran");
        assert_eq!(
            recorded,
            signed_out_line(&named) + &signed_out_line(&refusing)
        );
    }
}
