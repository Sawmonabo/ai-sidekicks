//! The one place a Claude Code process's environment is composed: the session's environment with
//! the run's credential variables and the withheld names removed, then the variables the app sets
//! on every Claude Code process, the account's folders where it runs on one, and its scratch
//! folder, which the daemon keeps under its own data folder for each Claude Code home.

use std::path::{Path, PathBuf};

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_platforms::PathRules;

use crate::provider::driver::claude::DESCRIPTOR;
use crate::provider::spawn_environment::{
    ProviderEnvironmentRequest, SessionEnvironment, SpawnEnvironmentError,
    build_provider_process_environment,
};

// The data folder's folder of Claude Code scratch folders, and in it the one of the person's own
// home and the folder of each account's.
const CLAUDE_SCRATCH_FOLDER: &str = "claude-scratch";
const OWN_HOME_SCRATCH_FOLDER: &str = "own-home";
const ACCOUNT_SCRATCH_FOLDERS: &str = "accounts";

/// The folders of an account the daemon manages, which Claude Code reads through
/// `CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR`; each an absolute path.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Claude driver's launch names an account's folders in it"
    )
)]
pub(crate) struct ClaudeAccountFolders {
    /// The configuration home.
    pub(crate) config_folder: String,
    /// The account's credential store.
    pub(crate) credential_store_folder: String,
}

/// What one Claude Code process's environment is built from.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Claude driver's launch builds each process's environment from it"
    )
)]
pub(crate) struct ClaudeProcessEnvironmentRequest<'a> {
    /// The session's environment.
    pub(crate) session: SessionEnvironment<'a>,
    /// The run's credential variables to remove.
    pub(crate) deny_env_vars: &'a [&'a str],
    /// The account's folders; `None`, the process runs on the person's own Claude Code home and
    /// sign-in.
    pub(crate) account_folders: Option<&'a ClaudeAccountFolders>,
    /// The daemon's data folder, an absolute path, which holds the scratch folder of each home.
    pub(crate) data_folder: &'a str,
    /// The account the process runs on; `None`, the person's own home.
    pub(crate) provider_account_id: Option<&'a ProviderAccountId>,
}

/// The daemon's own scratch folder for the Claude Code home of `provider_account_id` (`None`, the
/// person's own), under `data_folder`: every process of that home takes it as
/// `CLAUDE_CODE_TMPDIR`, so a session's temporary files sit where its purge finds them.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Claude driver's launch and purge find the scratch folder through it"
    )
)]
pub(crate) fn compose_claude_scratch_folder(
    data_folder: &str,
    provider_account_id: Option<&ProviderAccountId>,
) -> PathBuf {
    let scratch_folders = Path::new(data_folder).join(CLAUDE_SCRATCH_FOLDER);
    match provider_account_id {
        Some(account) => scratch_folders
            .join(ACCOUNT_SCRATCH_FOLDERS)
            .join(account.as_str()),
        None => scratch_folders.join(OWN_HOME_SCRATCH_FOLDER),
    }
}

/// The config folder a Claude Code process started in `spawn_environment`, in a place that spells
/// paths by `rules`, reads: `CLAUDE_CONFIG_DIR` where set, else `.claude` in that environment's
/// home, else in the daemon's own. `None` where no home is known at all.
pub(crate) fn claude_config_folder(
    spawn_environment: &[(String, String)],
    rules: PathRules,
) -> Option<PathBuf> {
    if let Some(configured) = rules.environment_value(spawn_environment, "CLAUDE_CONFIG_DIR") {
        return Some(PathBuf::from(configured));
    }
    let home = rules
        .environment_value(spawn_environment, rules.home_environment_name())
        .map(PathBuf::from)
        .or_else(std::env::home_dir)?;
    Some(home.join(".claude"))
}

/// The whole environment a session process, a relaunch or the sign-in check starts with, with
/// `additional_mandated_pairs` (a pair a caller sets on this one process) over it. Fails as
/// `build_provider_process_environment` does: a mandated name claimed twice, or an account or
/// scratch folder that is relative or ends up empty.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Claude driver's launch and sign-in check build their environment through it"
    )
)]
pub(crate) fn compose_claude_process_environment(
    request: ClaudeProcessEnvironmentRequest<'_>,
    additional_mandated_pairs: &[(String, String)],
) -> Result<Vec<(String, String)>, SpawnEnvironmentError> {
    let mut credential_homes = Vec::with_capacity(3);
    if let Some(folders) = request.account_folders {
        credential_homes.push((
            "CLAUDE_CONFIG_DIR".to_owned(),
            folders.config_folder.clone(),
        ));
        credential_homes.push((
            "CLAUDE_SECURESTORAGE_CONFIG_DIR".to_owned(),
            folders.credential_store_folder.clone(),
        ));
    }
    credential_homes.push((
        "CLAUDE_CODE_TMPDIR".to_owned(),
        compose_claude_scratch_folder(request.data_folder, request.provider_account_id)
            .to_string_lossy()
            .into_owned(),
    ));
    build_provider_process_environment(
        &ProviderEnvironmentRequest {
            session: request.session,
            descriptor: &DESCRIPTOR,
            deny_env_vars: request.deny_env_vars,
            credential_homes: &credential_homes,
        },
        additional_mandated_pairs,
    )
}

#[cfg(test)]
mod tests {
    use sidekicks_platforms::PathRules;

    use super::{ClaudeProcessEnvironmentRequest, compose_claude_process_environment};
    use crate::provider::spawn_environment::{
        ReservedEnvironmentNames, SessionEnvironment, SpawnEnvironmentError,
    };

    fn request<'a>(
        base: &'a [(String, String)],
        reserved_names: &'a ReservedEnvironmentNames,
        data_folder: &'a str,
    ) -> ClaudeProcessEnvironmentRequest<'a> {
        ClaudeProcessEnvironmentRequest {
            session: SessionEnvironment {
                base,
                every_project_rows: &[],
                project_rows: &[],
                reserved_names,
                rules: PathRules::Posix,
            },
            deny_env_vars: &[],
            account_folders: None,
            data_folder,
            provider_account_id: None,
        }
    }

    #[test]
    fn the_scratch_folder_is_set_on_the_persons_own_home_over_the_shells_value() {
        let base = vec![("CLAUDE_CODE_TMPDIR".to_owned(), "/tmp/shell".to_owned())];
        let reserved_names = ReservedEnvironmentNames::of_providers(&[]);

        let environment =
            compose_claude_process_environment(request(&base, &reserved_names, "/data"), &[])
                .expect("the environment builds");

        assert_eq!(
            PathRules::Posix.environment_value(&environment, "CLAUDE_CODE_TMPDIR"),
            Some("/data/claude-scratch/own-home")
        );
        assert_eq!(
            compose_claude_process_environment(request(&base, &reserved_names, "data"), &[]),
            Err(SpawnEnvironmentError::AccountFolderNotAbsolute {
                name: "CLAUDE_CODE_TMPDIR".to_owned()
            })
        );
    }
}
