//! The one place a Claude Code process's environment is composed: the session's environment with
//! the run's credential variables and the withheld names (the person's telemetry settings among
//! them) removed, then the variables the app sets on every Claude Code process, the question
//! tool's switches among them, and the home it runs on: an account's folders with the scratch
//! folder the daemon keeps under its own data folder for each configuration home, a throwaway
//! folder that holds all three for one read, or a throwaway folder on an account's own credential
//! store; or, for a read that fills a server entry's variables, no home at all.

use std::path::{Path, PathBuf};

use sidekicks_contracts::wire::text::is_ecmascript_whitespace;
use sidekicks_platforms::PathRules;

use crate::driver::ProviderAccountFolders;
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::account::credentials::{
    CONFIG_FOLDER_VARIABLE, SECURE_STORAGE_FOLDER_VARIABLE,
};
use crate::service_log::provider_home_key;
use crate::spawn_environment::{
    ProviderEnvironmentRequest, SessionEnvironment, SpawnEnvironmentError,
    WithheldEnvironmentNames, build_provider_process_environment,
};

// The person's telemetry settings no Claude Code process inherits, so its exports reach only the
// daemon's receiver: every `OTEL_` name and the switches Claude Code reads beside them. The
// person's opt-outs of Anthropic's own telemetry (`DISABLE_TELEMETRY`,
// `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`) are kept.
const CLAUDE_TELEMETRY_WITHHELD: WithheldEnvironmentNames<'static> = WithheldEnvironmentNames {
    prefixes: &["OTEL_"],
    names: &[
        "BETA_TRACING_ENDPOINT",
        "ENABLE_BETA_TRACING_DETAILED",
        "CLAUDE_CODE_ENABLE_TELEMETRY",
        "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA",
        "ENABLE_ENHANCED_TELEMETRY_BETA",
        "CLAUDE_CODE_OTEL_FLUSH_TIMEOUT_MS",
        "CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS",
    ],
};

// The data folder's folder of Claude Code scratch folders, and in it the folder of each home's.
const CLAUDE_SCRATCH_FOLDER: &str = "claude-scratch";
const HOME_SCRATCH_FOLDERS: &str = "homes";

/// The key that has a resumed Claude Code process continue the turn its conversation left
/// interrupted, which it otherwise leaves as it is.
pub(crate) const CLAUDE_RESUME_INTERRUPTED_TURN_KEY: &str = "CLAUDE_CODE_RESUME_INTERRUPTED_TURN";

/// The key that has the continued turn keep the tool calls the interruption cut off, marked so.
pub(crate) const CLAUDE_RESUME_SHOWS_CUT_OFF_CALLS_KEY: &str =
    "CLAUDE_CODE_RESUME_SHOWS_CUT_OFF_CALLS";

/// The key whose value replaces the words Claude Code sends to continue the interrupted turn.
pub(crate) const CLAUDE_RESUME_PROMPT_KEY: &str = "CLAUDE_CODE_RESUME_PROMPT";

/// The key bounding how old the conversation's last message may be for its turn to continue; a
/// positive bound replaces the six hours Claude Code holds some turns to.
pub(crate) const CLAUDE_RESUME_MAX_AGE_KEY: &str = "CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS";

// The largest finite double, in milliseconds, so a turn interrupted however long ago continues.
const CLAUDE_RESUME_ANY_AGE_MS: &str = "1.7976931348623157e308";

// Every key that continues an interrupted turn, which only the resume's own process carries.
const CLAUDE_RESUME_INTERRUPTED_TURN_KEYS: [&str; 4] = [
    CLAUDE_RESUME_INTERRUPTED_TURN_KEY,
    CLAUDE_RESUME_SHOWS_CUT_OFF_CALLS_KEY,
    CLAUDE_RESUME_PROMPT_KEY,
    CLAUDE_RESUME_MAX_AGE_KEY,
];

/// The variable naming the descriptor of the pipe a pasted token is handed on, which only the
/// daemon's start sets.
pub(crate) const CLAUDE_OAUTH_TOKEN_DESCRIPTOR_VARIABLE: &str =
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR";

/// The switches that each move Claude Code to a provider other than Anthropic's own API, in the
/// order it reads them.
pub(crate) const CLAUDE_PROVIDER_SWITCH_VARIABLES: [&str; 6] = [
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_VERTEX",
];

/// The switch Claude Code reads, with `ANTHROPIC_BASE_URL` and a token, to make its provider the
/// gateway.
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
    /// An account's folders, its configuration home possibly the one a switch left its
    /// conversation in, with the scratch folder the daemon keeps for that home.
    Account {
        /// The account's folders.
        folders: &'a ClaudeAccountFolders,
    },
    /// A folder the daemon made for one read and removes after it, an absolute path: the
    /// configuration home, the credential store and the scratch folder all sit in it, so the read
    /// signs in nowhere and keeps nothing.
    Throwaway {
        /// The folder.
        folder: &'a Path,
    },
    /// A folder the daemon made for one read of an account and removes after it, an absolute
    /// path, holding the configuration home and the scratch folder, over the account's own
    /// credential store: the read signs in as that account and keeps nothing in its home.
    AccountStore {
        /// The folder.
        folder: &'a Path,
        /// The account's credential store.
        credential_store_folder: &'a str,
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
    /// The daemon's data folder, an absolute path, which holds each home's scratch folder.
    pub(crate) data_folder: &'a str,
}

/// The daemon's own scratch folder for the Claude Code configuration home `config_folder`, under
/// `data_folder`, named by the home's key rather than its path: every process of that home takes
/// it as `CLAUDE_CODE_TMPDIR`, whichever account it signs in to, so a session's temporary files
/// stay beside its conversation and sit where its purge finds them.
pub(crate) fn compose_claude_scratch_folder(data_folder: &str, config_folder: &Path) -> PathBuf {
    Path::new(data_folder)
        .join(CLAUDE_SCRATCH_FOLDER)
        .join(HOME_SCRATCH_FOLDERS)
        .join(provider_home_key(config_folder))
}

/// The config folder a Claude Code process started in `spawn_environment`, in a place that spells
/// paths by `rules`, reads: `CLAUDE_CONFIG_DIR` where set, else `.claude` in that environment's
/// home, else in the daemon's own. `None` where no home is known at all.
pub(crate) fn claude_config_folder(
    spawn_environment: &[(String, String)],
    rules: PathRules,
) -> Option<PathBuf> {
    if let Some(configured) = rules.environment_value(spawn_environment, CONFIG_FOLDER_VARIABLE) {
        return Some(PathBuf::from(configured));
    }
    let home = rules
        .environment_value(spawn_environment, rules.home_environment_name())
        .map(PathBuf::from)
        .or_else(std::env::home_dir)?;
    Some(home.join(".claude"))
}

/// The value of the text variable `name` in `environment` as Claude Code reads it: trimmed of
/// ECMAScript white space, an empty value read as unset.
pub(crate) fn claude_text_variable<'environment>(
    environment: &'environment [(String, String)],
    name: &str,
) -> Option<&'environment str> {
    PathRules::NATIVE
        .environment_value(environment, name)
        .map(|value| value.trim_matches(is_ecmascript_whitespace))
        .filter(|value| !value.is_empty())
}

/// The whole environment a session process, a relaunch or the sign-in check starts with, the
/// person's telemetry settings withheld, the question tool's previews and extended questions
/// switched on, with `additional_mandated_pairs` (a pair a caller sets on this one process) over
/// it. Fails as `build_provider_process_environment` does: a mandated name claimed twice, or an
/// account or scratch folder that is relative or ends up empty.
pub(crate) fn compose_claude_process_environment(
    request: ClaudeProcessEnvironmentRequest<'_>,
    additional_mandated_pairs: &[(String, String)],
) -> Result<Vec<(String, String)>, SpawnEnvironmentError> {
    let (config_folder, credential_store_folder, scratch_folder) = match request.home {
        ClaudeProcessHome::Account { folders } => (
            folders.config_folder.clone(),
            folders.credential_store_folder.clone(),
            compose_claude_scratch_folder(request.data_folder, Path::new(&folders.config_folder))
                .to_string_lossy()
                .into_owned(),
        ),
        ClaudeProcessHome::Throwaway { folder } => {
            let folder = folder.to_string_lossy().into_owned();
            (folder.clone(), folder.clone(), folder)
        }
        ClaudeProcessHome::AccountStore {
            folder,
            credential_store_folder,
        } => {
            let folder = folder.to_string_lossy().into_owned();
            (folder.clone(), credential_store_folder.to_owned(), folder)
        }
    };
    let credential_homes = [
        (CONFIG_FOLDER_VARIABLE.to_owned(), config_folder),
        (
            SECURE_STORAGE_FOLDER_VARIABLE.to_owned(),
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
        CLAUDE_TELEMETRY_WITHHELD,
    )
}

/// The environment a Claude Code process composes from `session` on no home of the daemon's: the
/// names [`compose_claude_process_environment`] withholds withheld and the app's variables set,
/// with no config, credential or scratch folder, so a read fills an entry's variables as the
/// process would. Fails as `build_provider_process_environment` does: an inherited account folder
/// variable that is empty.
pub(crate) fn compose_claude_environment_without_home(
    session: SessionEnvironment<'_>,
) -> Result<Vec<(String, String)>, SpawnEnvironmentError> {
    build_provider_process_environment(
        &ProviderEnvironmentRequest {
            session,
            descriptor: &DESCRIPTOR,
            deny_env_vars: &[],
            credential_homes: &[],
        },
        &[],
        CLAUDE_TELEMETRY_WITHHELD,
    )
}

/// The keys a resumed process continues its interrupted turn with: the turn continued however old,
/// its cut-off calls shown, and `prompt` as the words it continues with, where given; without one,
/// Claude Code's own words stand.
pub(crate) fn interrupted_turn_resume_environment(prompt: Option<&str>) -> Vec<(String, String)> {
    [
        (CLAUDE_RESUME_INTERRUPTED_TURN_KEY, Some("1")),
        (CLAUDE_RESUME_SHOWS_CUT_OFF_CALLS_KEY, Some("1")),
        (CLAUDE_RESUME_MAX_AGE_KEY, Some(CLAUDE_RESUME_ANY_AGE_MS)),
        (CLAUDE_RESUME_PROMPT_KEY, prompt),
    ]
    .into_iter()
    .filter_map(|(name, value)| Some((name.to_owned(), value?.to_owned())))
    .collect()
}

/// `environment` without the keys that continue an interrupted turn, which a resume sets on the one
/// process it starts, so no later process started from the same environment continues it.
pub(crate) fn without_interrupted_turn_resume(
    environment: Vec<(String, String)>,
) -> Vec<(String, String)> {
    environment
        .into_iter()
        .filter(|(name, _)| !CLAUDE_RESUME_INTERRUPTED_TURN_KEYS.contains(&name.as_str()))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use rstest::rstest;
    use sidekicks_contracts::machine::settings::EnvironmentRow;
    use sidekicks_contracts::wire::text::{BoundedText, NulFreeText};
    use sidekicks_platforms::PathRules;
    use sidekicks_workspace::project::refusals::refuse_environment_rows;

    use super::{
        CLAUDE_OAUTH_TOKEN_DESCRIPTOR_VARIABLE, ClaudeAccountFolders,
        ClaudeProcessEnvironmentRequest, ClaudeProcessHome, compose_claude_process_environment,
        interrupted_turn_resume_environment, without_interrupted_turn_resume,
    };
    use crate::driver::claude::DESCRIPTOR;
    use crate::driver::claude::account::credentials::{
        OAUTH_TOKEN_VARIABLE, SECURE_STORAGE_FOLDER_VARIABLE,
    };
    use crate::spawn_environment::{
        ReservedEnvironmentNames, SessionEnvironment, SpawnEnvironmentError,
    };

    // Killed by a scratch folder shared across homes, which a purge of one home would sweep for
    // every other, by one named by the home's path, by a shell's own value winning over the
    // home's or over the question tool's switches, and by either switch left off.
    #[test]
    fn the_app_s_own_values_are_set_over_the_shells() {
        let base = vec![
            ("CLAUDE_CODE_TMPDIR".to_owned(), "/tmp/shell".to_owned()),
            ("CLAUDE_CODE_QUESTION_EXTENDED".to_owned(), "0".to_owned()),
        ];
        let reserved_names = ReservedEnvironmentNames::of_providers(&[]);
        let folders = |name: &str| ClaudeAccountFolders {
            config_folder: format!("/accounts/{name}/config"),
            credential_store_folder: format!("/accounts/{name}/credentials"),
        };
        let request = |data_folder, folders| ClaudeProcessEnvironmentRequest {
            session: SessionEnvironment {
                base: &base,
                every_project_rows: &[],
                project_rows: &[],
                reserved_names: &reserved_names,
                rules: PathRules::Posix,
            },
            deny_env_vars: &[],
            home: ClaudeProcessHome::Account { folders },
            data_folder,
        };
        let scratch_of = |folders| {
            let environment = compose_claude_process_environment(request("/data", folders), &[])
                .expect("the environment builds");
            PathRules::Posix
                .environment_value(&environment, "CLAUDE_CODE_TMPDIR")
                .map(str::to_owned)
        };

        let (one, two) = (folders("one"), folders("two"));
        let scratch = scratch_of(&one).expect("the scratch folder is set");
        assert!(
            scratch.starts_with("/data/claude-scratch/homes/"),
            "{scratch}"
        );
        assert!(
            !scratch.contains("accounts"),
            "the folder names no path: {scratch}"
        );
        assert_ne!(scratch_of(&two), Some(scratch));
        let environment = compose_claude_process_environment(request("/data", &one), &[])
            .expect("the environment builds");
        assert_eq!(
            PathRules::Posix.environment_value(&environment, "CLAUDE_CODE_QUESTION_EXTENDED"),
            Some("1")
        );
        assert_eq!(
            PathRules::Posix.environment_value(&environment, "CLAUDE_CODE_QUESTION_PREVIEW_FORMAT"),
            Some("markdown")
        );
        assert_eq!(
            compose_claude_process_environment(request("data", &one), &[]),
            Err(SpawnEnvironmentError::AccountFolderNotAbsolute {
                name: "CLAUDE_CODE_TMPDIR".to_owned()
            })
        );
    }

    // Killed by either token variable left off the withheld names: a shell's own token would beat
    // the account's, and a shell's empty or stale descriptor would reach Claude Code, which only
    // the daemon's start sets. Also killed by a read on an account's store kept in the account's
    // own configuration home.
    #[test]
    fn a_read_on_an_account_s_store_takes_no_token_variable_from_the_shell() {
        let reserved_names = ReservedEnvironmentNames::of_providers(&[]);

        for inherited in ["", "7"] {
            let base = vec![
                (
                    CLAUDE_OAUTH_TOKEN_DESCRIPTOR_VARIABLE.to_owned(),
                    inherited.to_owned(),
                ),
                (
                    OAUTH_TOKEN_VARIABLE.to_owned(),
                    "sk-ant-oat01-shell-token".to_owned(),
                ),
            ];
            let request = ClaudeProcessEnvironmentRequest {
                session: SessionEnvironment {
                    base: &base,
                    every_project_rows: &[],
                    project_rows: &[],
                    reserved_names: &reserved_names,
                    rules: PathRules::Posix,
                },
                deny_env_vars: &[],
                home: ClaudeProcessHome::AccountStore {
                    folder: Path::new("/data/read"),
                    credential_store_folder: "/accounts/one/store",
                },
                data_folder: "/data",
            };
            let environment =
                compose_claude_process_environment(request, &[]).expect("the environment builds");

            let value = |name| PathRules::Posix.environment_value(&environment, name);
            assert_eq!(value(CLAUDE_OAUTH_TOKEN_DESCRIPTOR_VARIABLE), None);
            assert_eq!(value(OAUTH_TOKEN_VARIABLE), None);
            assert_eq!(value("CLAUDE_CONFIG_DIR"), Some("/data/read"));
            assert_eq!(
                value(SECURE_STORAGE_FOLDER_VARIABLE),
                Some("/accounts/one/store")
            );
            assert_eq!(value("CLAUDE_CODE_TMPDIR"), Some("/data/read"));
        }
    }

    // A resume continues its turn however old, its cut-off calls kept, with the words it is given
    // and Claude Code's own where it is given none. Killed by any key dropped, by the age written
    // as anything but the largest finite double, and by the prompt key set with no words.
    #[test]
    fn a_resume_continues_its_turn_with_the_words_it_is_given() {
        let pairs = |prompt| {
            interrupted_turn_resume_environment(prompt)
                .into_iter()
                .map(|(name, value)| format!("{name}={value}"))
                .collect::<Vec<_>>()
        };

        assert_eq!(
            pairs(Some("The person approved it.")),
            [
                "CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1",
                "CLAUDE_CODE_RESUME_SHOWS_CUT_OFF_CALLS=1",
                "CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS=1.7976931348623157e308",
                "CLAUDE_CODE_RESUME_PROMPT=The person approved it.",
            ]
        );
        assert_eq!(
            pairs(None),
            [
                "CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1",
                "CLAUDE_CODE_RESUME_SHOWS_CUT_OFF_CALLS=1",
                "CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS=1.7976931348623157e308",
            ]
        );
    }

    // Only the resume's own process continues an interrupted turn: a shell's keys reach no process,
    // the resume's own keys win over them, and a later process started from the resume's
    // environment carries none. Killed by any of the four left off the withheld names, and by the
    // strip limited to the first key.
    #[test]
    fn no_process_but_the_resume_s_own_continues_an_interrupted_turn() {
        let resume_keys = [
            "CLAUDE_CODE_RESUME_INTERRUPTED_TURN",
            "CLAUDE_CODE_RESUME_SHOWS_CUT_OFF_CALLS",
            "CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS",
            "CLAUDE_CODE_RESUME_PROMPT",
        ];
        let base: Vec<_> = resume_keys
            .iter()
            .map(|name| ((*name).to_owned(), "shell".to_owned()))
            .collect();
        let reserved_names = ReservedEnvironmentNames::of_providers(&[]);
        let folders = ClaudeAccountFolders {
            config_folder: "/accounts/one/config".to_owned(),
            credential_store_folder: "/accounts/one/credentials".to_owned(),
        };
        let environment = |mandated_pairs: &[(String, String)]| {
            let request = ClaudeProcessEnvironmentRequest {
                session: SessionEnvironment {
                    base: &base,
                    every_project_rows: &[],
                    project_rows: &[],
                    reserved_names: &reserved_names,
                    rules: PathRules::Posix,
                },
                deny_env_vars: &[],
                home: ClaudeProcessHome::Account { folders: &folders },
                data_folder: "/data",
            };
            compose_claude_process_environment(request, mandated_pairs)
                .expect("the environment builds")
        };
        let resume_values = |environment: &[(String, String)]| {
            resume_keys.map(|name| {
                PathRules::Posix
                    .environment_value(environment, name)
                    .map(str::to_owned)
            })
        };

        assert_eq!(resume_values(&environment(&[])), [None, None, None, None]);
        let resumed = environment(&interrupted_turn_resume_environment(Some("words")));
        assert_eq!(
            resume_values(&resumed),
            [
                Some("1".to_owned()),
                Some("1".to_owned()),
                Some("1.7976931348623157e308".to_owned()),
                Some("words".to_owned()),
            ]
        );
        assert_eq!(
            resume_values(&without_interrupted_turn_resume(resumed)),
            [None, None, None, None]
        );
    }

    // A person's row naming either question switch is refused at save, as every name the app sets
    // on a Claude Code process is. Killed by the switches set outside the descriptor's variables.
    #[rstest]
    #[case::previews("CLAUDE_CODE_QUESTION_PREVIEW_FORMAT")]
    #[case::extended_questions("claude_code_question_extended")]
    fn a_row_naming_a_question_switch_is_refused(#[case] name: &str) {
        let reserved_names = ReservedEnvironmentNames::of_providers(&[&DESCRIPTOR]);
        let row = EnvironmentRow {
            name: BoundedText::new(name.to_owned()).expect("the test's name is bounded"),
            value: NulFreeText::new("0".to_owned()).expect("the test's value has no NUL"),
        };

        assert!(refuse_environment_rows(&[row], reserved_names.names()).is_err());
    }
}
