//! The one place a Claude Code process's environment is composed: the session's environment with
//! the run's credential variables and the withheld names removed, then the variables the app sets
//! on every Claude Code process, the account's folders where it runs on one, and its scratch
//! folder, which the daemon keeps under its own data folder for each Claude Code home.

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
pub(crate) struct ClaudeAccountFolders {
    /// The configuration home.
    pub(crate) config_folder: String,
    /// The account's credential store.
    pub(crate) credential_store_folder: String,
}

/// What one Claude Code process's environment is built from.
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
/// person's own), under `data_folder` in a place that spells paths by `path_rules`: every process
/// of that home takes it as `CLAUDE_CODE_TMPDIR`, so a session's temporary files sit where its
/// purge finds them.
pub(crate) fn compose_claude_scratch_folder(
    data_folder: &str,
    provider_account_id: Option<&ProviderAccountId>,
    path_rules: PathRules,
) -> String {
    let separator = path_rules.separator().to_string();
    let mut parts = vec![data_folder, CLAUDE_SCRATCH_FOLDER];
    match provider_account_id {
        Some(account) => parts.extend([ACCOUNT_SCRATCH_FOLDERS, account.as_str()]),
        None => parts.push(OWN_HOME_SCRATCH_FOLDER),
    }
    parts.join(&separator)
}

/// The whole environment a session process, a relaunch or the sign-in check starts with, with
/// `additional_mandated_pairs` (a pair a caller sets on this one process) over it. Fails as
/// `build_provider_process_environment` does: a mandated name claimed twice, or an account or
/// scratch folder that is relative or ends up empty.
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
        compose_claude_scratch_folder(
            request.data_folder,
            request.provider_account_id,
            request.session.rules,
        ),
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
        ReservedEnvironmentNames, SessionEnvironment, SpawnEnvironmentError, read_environment_value,
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
            read_environment_value(&environment, "CLAUDE_CODE_TMPDIR", PathRules::Posix),
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
