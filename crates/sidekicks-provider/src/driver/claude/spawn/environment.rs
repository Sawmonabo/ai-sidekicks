//! The one place a Claude Code process's environment is composed: the session's environment with
//! the run's credential variables and the withheld names removed, then the variables the app sets
//! on every Claude Code process, and the home it runs on: an account's folders with the scratch
//! folder the daemon keeps under its own data folder for each account, or a throwaway folder that
//! holds all three for one read.

use std::path::{Path, PathBuf};

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::wire::text::is_ecmascript_whitespace;
use sidekicks_platforms::PathRules;

use crate::driver::ProviderAccountFolders;
use crate::driver::claude::DESCRIPTOR;
use crate::spawn_environment::{
    ProviderEnvironmentRequest, SessionEnvironment, SpawnEnvironmentError,
    build_provider_process_environment,
};

// The data folder's folder of Claude Code scratch folders, and in it the folder of each account's.
const CLAUDE_SCRATCH_FOLDER: &str = "claude-scratch";
const ACCOUNT_SCRATCH_FOLDERS: &str = "accounts";

/// The switches that each move Claude Code to a provider other than Anthropic's own API, in the
/// order it reads them (`Ae`, b:9648677).
pub(crate) const CLAUDE_PROVIDER_SWITCH_VARIABLES: [&str; 6] = [
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_VERTEX",
];

/// The switch `Su` reads, with `ANTHROPIC_BASE_URL` and a token, to make Claude Code's provider
/// the gateway (b:12043582).
pub(crate) const CLAUDE_GATEWAY_SWITCH_VARIABLE: &str = "CLAUDE_CODE_USE_GATEWAY";

/// The folders of an account the daemon manages, which Claude Code reads through
/// `CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR`; each an absolute path.
pub(crate) struct ClaudeAccountFolders {
    /// The configuration home.
    pub(crate) config_folder: String,
    /// The account's credential store.
    pub(crate) credential_store_folder: String,
}

impl From<&ProviderAccountFolders> for ClaudeAccountFolders {
    fn from(folders: &ProviderAccountFolders) -> Self {
        Self {
            config_folder: folders.configuration_folder.to_string_lossy().into_owned(),
            credential_store_folder: folders
                .credential_store_folder
                .to_string_lossy()
                .into_owned(),
        }
    }
}

/// The Claude Code home one process runs on.
pub(crate) enum ClaudeProcessHome<'a> {
    /// An account's home, with the scratch folder the daemon keeps for it.
    Account {
        /// The account's folders.
        folders: &'a ClaudeAccountFolders,
        /// The account.
        provider_account_id: &'a ProviderAccountId,
    },
    /// A folder the daemon made for one read and removes after it, an absolute path: the
    /// configuration home, the credential store and the scratch folder all sit in it, so the read
    /// signs in nowhere and keeps nothing.
    Throwaway {
        /// The folder.
        folder: &'a Path,
    },
}

/// What one Claude Code process's environment is built from.
pub(crate) struct ClaudeProcessEnvironmentRequest<'a> {
    /// The session's environment.
    pub(crate) session: SessionEnvironment<'a>,
    /// The run's credential variables to remove.
    pub(crate) deny_env_vars: &'a [&'a str],
    /// The home the process runs on.
    pub(crate) home: ClaudeProcessHome<'a>,
    /// The daemon's data folder, an absolute path, which holds each account's scratch folder.
    pub(crate) data_folder: &'a str,
}

/// The daemon's own scratch folder for `provider_account_id`'s Claude Code home, under
/// `data_folder`: every process of that home takes it as `CLAUDE_CODE_TMPDIR`, so a session's
/// temporary files sit where its purge finds them.
pub(crate) fn compose_claude_scratch_folder(
    data_folder: &str,
    provider_account_id: &ProviderAccountId,
) -> PathBuf {
    Path::new(data_folder)
        .join(CLAUDE_SCRATCH_FOLDER)
        .join(ACCOUNT_SCRATCH_FOLDERS)
        .join(provider_account_id.as_str())
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

/// The value of the text variable `name` in `environment` as Claude Code reads it (`t`,
/// b:8907349): trimmed of ECMAScript white space, an empty value read as unset.
pub(crate) fn claude_text_variable<'environment>(
    environment: &'environment [(String, String)],
    name: &str,
) -> Option<&'environment str> {
    PathRules::NATIVE
        .environment_value(environment, name)
        .map(|value| value.trim_matches(is_ecmascript_whitespace))
        .filter(|value| !value.is_empty())
}

/// The whole environment a session process, a relaunch or the sign-in check starts with, with
/// `additional_mandated_pairs` (a pair a caller sets on this one process) over it. Fails as
/// `build_provider_process_environment` does: a mandated name claimed twice, or an account or
/// scratch folder that is relative or ends up empty.
pub(crate) fn compose_claude_process_environment(
    request: ClaudeProcessEnvironmentRequest<'_>,
    additional_mandated_pairs: &[(String, String)],
) -> Result<Vec<(String, String)>, SpawnEnvironmentError> {
    let (config_folder, credential_store_folder, scratch_folder) = match request.home {
        ClaudeProcessHome::Account {
            folders,
            provider_account_id,
        } => (
            folders.config_folder.clone(),
            folders.credential_store_folder.clone(),
            compose_claude_scratch_folder(request.data_folder, provider_account_id)
                .to_string_lossy()
                .into_owned(),
        ),
        ClaudeProcessHome::Throwaway { folder } => {
            let folder = folder.to_string_lossy().into_owned();
            (folder.clone(), folder.clone(), folder)
        }
    };
    let credential_homes = [
        ("CLAUDE_CONFIG_DIR".to_owned(), config_folder),
        (
            "CLAUDE_SECURESTORAGE_CONFIG_DIR".to_owned(),
            credential_store_folder,
        ),
        ("CLAUDE_CODE_TMPDIR".to_owned(), scratch_folder),
    ];
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

    use super::{
        ClaudeAccountFolders, ClaudeProcessEnvironmentRequest, ClaudeProcessHome,
        compose_claude_process_environment,
    };
    use crate::runtime_binding::test_store::test_provider_account_id;
    use crate::spawn_environment::{
        ReservedEnvironmentNames, SessionEnvironment, SpawnEnvironmentError,
    };

    // Killed by a scratch folder shared across accounts, which a purge of one account would sweep
    // for every other, and by a shell's own value winning over the account's.
    #[test]
    fn the_account_s_own_scratch_folder_is_set_over_the_shells_value() {
        let base = vec![("CLAUDE_CODE_TMPDIR".to_owned(), "/tmp/shell".to_owned())];
        let reserved_names = ReservedEnvironmentNames::of_providers(&[]);
        let folders = ClaudeAccountFolders {
            config_folder: "/accounts/one/config".to_owned(),
            credential_store_folder: "/accounts/one/credentials".to_owned(),
        };
        let provider_account_id = test_provider_account_id();
        let request = |data_folder| ClaudeProcessEnvironmentRequest {
            session: SessionEnvironment {
                base: &base,
                every_project_rows: &[],
                project_rows: &[],
                reserved_names: &reserved_names,
                rules: PathRules::Posix,
            },
            deny_env_vars: &[],
            home: ClaudeProcessHome::Account {
                folders: &folders,
                provider_account_id: &provider_account_id,
            },
            data_folder,
        };

        let environment = compose_claude_process_environment(request("/data"), &[])
            .expect("the environment builds");

        assert_eq!(
            PathRules::Posix.environment_value(&environment, "CLAUDE_CODE_TMPDIR"),
            Some("/data/claude-scratch/accounts/account-1")
        );
        assert_eq!(
            compose_claude_process_environment(request("data"), &[]),
            Err(SpawnEnvironmentError::AccountFolderNotAbsolute {
                name: "CLAUDE_CODE_TMPDIR".to_owned()
            })
        );
    }
}
