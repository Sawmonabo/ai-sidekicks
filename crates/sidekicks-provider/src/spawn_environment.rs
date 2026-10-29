//! The environment of every process the daemon starts. Each starts from the login shell's
//! environment with the person's rows laid over it, a row naming a variable the app sets dropped:
//!
//! - a provider's process loses the run's credential variables and the names its driver withholds,
//!   then gets its driver's process variables and the account's folders, which nothing overrides;
//! - the commands a provider's conversation runs lose the same names and get the account's folders,
//!   without the process variables;
//! - a command the person's project runs (a setup command, a Terminal pane's shell) keeps every
//!   variable, credentials included, since it may need them.
//!
//! Every name is compared under the spelling rules of the place the child runs in, so on Windows
//! `path` is the same variable as `PATH`. Each builder's result is the child's whole environment:
//! a spawner starts the child with `env_clear()` then `envs(result)`, never `envs` over the
//! inherited environment, because `Command` folds names only on Windows and keeps the first
//! spelling, so an inherited spelling could survive beside the builder's.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

use sidekicks_contracts::machine::settings::{
    EnvironmentNameRefusalReason, EnvironmentRow, environment_name_refusal,
};
use sidekicks_platforms::PathRules;

use crate::driver::ProviderDescriptor;

/// The names a person's row may not set because a registered driver sets them: every driver's
/// process, launch, credential-home, screen-reader and background-work switch names; and every
/// driver's background-work switch, which every provider's process and conversation commands get,
/// so no provider's agent starts another's background work. Built once at the daemon's start.
pub struct ReservedEnvironmentNames {
    names: Vec<&'static str>,
    background_work_off_switches: Vec<(&'static str, &'static str)>,
}

impl ReservedEnvironmentNames {
    /// The names every one of `descriptors` sets, so a row naming any of them is dropped whichever
    /// provider the session runs, and their background-work switches.
    pub fn of_providers(descriptors: &[&ProviderDescriptor]) -> Self {
        Self {
            names: descriptors
                .iter()
                .copied()
                .flat_map(ProviderDescriptor::app_set_environment_names)
                .collect(),
            background_work_off_switches: descriptors
                .iter()
                .filter_map(|descriptor| descriptor.background_work.as_ref())
                .map(|work| work.off_switch)
                .collect(),
        }
    }

    /// The names no row may set, each a name a registered driver sets on its processes.
    pub fn names(&self) -> &[&'static str] {
        &self.names
    }
}

/// What every environment the daemon builds for one session starts from.
pub struct SessionEnvironment<'a> {
    /// The login shell's environment captured at the daemon's start, never the daemon's own.
    pub base: &'a [(String, String)],
    /// The machine's `Every project` rows.
    pub every_project_rows: &'a [EnvironmentRow],
    /// The session's project's own rows, which win over an `Every project` row of the same name.
    pub project_rows: &'a [EnvironmentRow],
    /// The names no row may set.
    pub reserved_names: &'a ReservedEnvironmentNames,
    /// The spelling rules of the place the child runs in, under which every name is compared.
    pub rules: PathRules,
}

/// What a provider's process and the commands its conversation runs both start from.
pub struct ProviderEnvironmentRequest<'a> {
    /// The session's environment.
    pub session: SessionEnvironment<'a>,
    /// The provider's descriptor, whose withheld and process names apply.
    pub descriptor: &'a ProviderDescriptor,
    /// The run's credential variables to remove, its resolved credential policy's `deny_env_vars`.
    pub deny_env_vars: &'a [&'a str],
    /// The pairs that point the provider at one account's folders, composed by its driver: each
    /// name one of the descriptor's credential-home names, each value an absolute path. Empty, the
    /// provider runs on the person's own configuration and sign-in.
    pub credential_homes: &'a [(String, String)],
}

/// Why a provider's environment could not be built. Each names the variable and never its value,
/// which can hold a credential.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum SpawnEnvironmentError {
    /// Two mandated values claim one name, refused even when equal: the last winning could lower
    /// the auto-update opt-out, and the first winning would drop an account's folder.
    #[error(
        "two mandated environment values claim the variable {name}, already claimed as \
         {claimed_as}"
    )]
    MandatedNameConflict {
        /// The name the later value claims.
        name: String,
        /// The earlier value's spelling of it.
        claimed_as: String,
    },
    /// An account folder given for the provider is not an absolute path.
    #[error("the account folder variable {name} is not an absolute path")]
    AccountFolderNotAbsolute {
        /// The variable.
        name: String,
    },
    /// An account folder variable is empty in the built environment, which would move the provider
    /// onto another sign-in unseen.
    #[error("the account folder variable {name} is set to an empty value")]
    AccountFolderEmpty {
        /// The variable.
        name: String,
    },
}

/// The provider process's whole environment: the session's, the run's credential variables and the
/// driver's withheld names removed, then the driver's process variables (its auto-update opt-out
/// among them), every driver's background-work switch, the account's folders and
/// `additional_mandated_pairs` (a pair a caller sets on this one process), which no base pair or
/// row overrides. Fails when two mandated pairs claim one name, or when an account folder is
/// relative or ends up empty.
pub(crate) fn build_provider_process_environment(
    request: &ProviderEnvironmentRequest<'_>,
    additional_mandated_pairs: &[(String, String)],
) -> Result<Vec<(String, String)>, SpawnEnvironmentError> {
    let process_pairs = request.descriptor.process_environment.iter().copied();
    let given_pairs = request
        .credential_homes
        .iter()
        .chain(additional_mandated_pairs)
        .map(|(name, value)| (name.as_str(), value.as_str()));
    build_driver_environment(request, process_pairs.chain(given_pairs))
}

/// The whole environment of the commands a provider's conversation runs: the session's, the run's
/// credential variables and the driver's withheld names removed, then every driver's
/// background-work switch and the account's folders. Fails as
/// `build_provider_process_environment` does for the account's folders.
pub fn build_conversation_command_environment(
    request: &ProviderEnvironmentRequest<'_>,
) -> Result<Vec<(String, String)>, SpawnEnvironmentError> {
    let credential_home_pairs = request
        .credential_homes
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_str()));
    build_driver_environment(request, credential_home_pairs)
}

/// The whole environment of a command the person's project runs: the session's, every variable
/// kept, since such a command may need a credential (`NPM_TOKEN` for a private registry).
pub fn build_project_command_environment(
    session: &SessionEnvironment<'_>,
) -> Vec<(String, String)> {
    layer_session_environment(session, []).into_pairs()
}

/// `environment` with `folder` first on its `PATH`, the variable's own spelling kept; a `PATH` it
/// lacks is set to `folder` alone. Names are compared under `rules`.
pub(crate) fn place_folder_first_on_search_path(
    environment: &mut Vec<(String, String)>,
    folder: &str,
    rules: PathRules,
) {
    let path_key = rules.environment_name_key("PATH");
    let mut is_path_set = false;
    for (name, value) in &mut *environment {
        if rules.environment_name_key(name) == path_key {
            is_path_set = true;
            *value = if value.is_empty() {
                folder.to_owned()
            } else {
                format!("{folder}{}{value}", rules.search_path_separator())
            };
        }
    }
    if !is_path_set {
        environment.push(("PATH".to_owned(), folder.to_owned()));
    }
}

/// `environment` without any pair that one of `names` names under `rules`.
pub fn remove_environment_names(
    environment: &mut Vec<(String, String)>,
    names: &[&str],
    rules: PathRules,
) {
    let removed_keys: HashSet<Cow<'_, str>> = names
        .iter()
        .map(|name| rules.environment_name_key(name))
        .collect();
    environment.retain(|(name, _)| !removed_keys.contains(&*rules.environment_name_key(name)));
}

/// The session's environment for a provider with every driver's background-work switch and
/// `mandated_pairs` set over it, which nothing in the session overrides.
fn build_driver_environment<'p>(
    request: &ProviderEnvironmentRequest<'_>,
    mandated_pairs: impl IntoIterator<Item = (&'p str, &'p str)>,
) -> Result<Vec<(String, String)>, SpawnEnvironmentError> {
    let off_switches = request
        .session
        .reserved_names
        .background_work_off_switches
        .iter()
        .copied();
    let mandated_pairs = off_switches.chain(mandated_pairs);
    let rules = request.session.rules;
    if let Some((name, _)) = request
        .credential_homes
        .iter()
        .find(|(_, folder)| !rules.is_absolute(folder))
    {
        return Err(SpawnEnvironmentError::AccountFolderNotAbsolute { name: name.clone() });
    }
    let removed_names = request
        .deny_env_vars
        .iter()
        .chain(request.descriptor.withheld_environment_names)
        .copied();
    let mut environment = layer_session_environment(&request.session, removed_names);

    let mut mandated_names_by_key: HashMap<Cow<'p, str>, &'p str> = HashMap::new();
    for (name, value) in mandated_pairs {
        let key = rules.environment_name_key(name);
        if let Some(claimed_as) = mandated_names_by_key.get(&key) {
            return Err(SpawnEnvironmentError::MandatedNameConflict {
                name: name.to_owned(),
                claimed_as: (*claimed_as).to_owned(),
            });
        }
        environment.set(key.clone().into_owned(), name, value);
        mandated_names_by_key.insert(key, name);
    }

    // An inherited empty account folder would move the process onto another sign-in unseen.
    let account_folder_keys: HashSet<Cow<'_, str>> = request
        .descriptor
        .credential_home_environment_names
        .iter()
        .map(|name| rules.environment_name_key(name))
        .collect();
    let pairs = environment.into_pairs();
    if let Some((name, _)) = pairs.iter().find(|(name, value)| {
        value.is_empty() && account_folder_keys.contains(&*rules.environment_name_key(name))
    }) {
        return Err(SpawnEnvironmentError::AccountFolderEmpty { name: name.clone() });
    }
    Ok(pairs)
}

/// The base with the rows set over it, every name `removed_names` names left out, a row naming a
/// reserved or app-set variable dropped. A later pair replaces an earlier one of its name, so a row
/// beats the base and a project row beats an `Every project` row.
fn layer_session_environment<'n>(
    session: &SessionEnvironment<'_>,
    removed_names: impl IntoIterator<Item = &'n str>,
) -> EnvironmentByName {
    let rules = session.rules;
    let removed_keys: HashSet<Cow<'n, str>> = removed_names
        .into_iter()
        .map(|name| rules.environment_name_key(name))
        .collect();
    let reserved_keys: HashSet<Cow<'static, str>> = session
        .reserved_names
        .names
        .iter()
        .copied()
        .map(|name| rules.environment_name_key(name))
        .collect();
    let rows = session
        .every_project_rows
        .iter()
        .chain(session.project_rows)
        .map(|row| (row.name.as_str(), row.value.as_str()))
        .filter(|(name, _)| {
            !matches!(
                environment_name_refusal(name),
                Some(EnvironmentNameRefusalReason::SetByApp)
            ) && !reserved_keys.contains(&*rules.environment_name_key(name))
        });
    let pairs = session
        .base
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .chain(rows);

    // Removing while layering, so a row can never put back a name the removal took out.
    let mut environment = EnvironmentByName::default();
    for (name, value) in pairs {
        let key = rules.environment_name_key(name);
        if !removed_keys.contains(&*key) {
            environment.set(key.into_owned(), name, value);
        }
    }
    environment
}

/// Pairs keyed by their folded names, one per name, in the order each name first appeared.
#[derive(Default)]
struct EnvironmentByName {
    slot_by_key: HashMap<String, usize>,
    pairs: Vec<(String, String)>,
}

impl EnvironmentByName {
    /// Sets `name` to `value` under `key`, replacing the spelling and value an earlier pair of that
    /// key left in its place.
    fn set(&mut self, key: String, name: &str, value: &str) {
        let pair = (name.to_owned(), value.to_owned());
        if let Some(&slot) = self.slot_by_key.get(&key) {
            self.pairs[slot] = pair;
        } else {
            self.slot_by_key.insert(key, self.pairs.len());
            self.pairs.push(pair);
        }
    }

    fn into_pairs(self) -> Vec<(String, String)> {
        self.pairs
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_contracts::machine::settings::{APP_SET_ENVIRONMENT_NAMES, EnvironmentRow};
    use sidekicks_contracts::wire::text::{BoundedText, NulFreeText};
    use sidekicks_platforms::{PathRules, PerSystem, SystemFolders};

    use super::{
        ProviderEnvironmentRequest, ReservedEnvironmentNames, SessionEnvironment,
        SpawnEnvironmentError, build_conversation_command_environment,
        build_project_command_environment, build_provider_process_environment,
    };
    use crate::driver::{
        BackgroundWork, CommandSandboxNeeds, ProviderCommand, ProviderDescriptor,
        ProviderMemoryEstimates,
    };

    /// A provider that sets, withholds and reserves names of its own.
    const DESCRIPTOR: ProviderDescriptor = ProviderDescriptor {
        id: "first",
        name: "First",
        release_notes_address: |_version| String::new(),
        plan_words: &[],
        built_in_tools: &[],
        command: ProviderCommand {
            windows: None,
            unix: None,
        },
        managed_settings_folders: SystemFolders {
            macos: None,
            linux: None,
            windows: None,
        },
        command_sandbox: PerSystem {
            macos: false,
            linux: false,
            windows: false,
        },
        command_sandbox_needs: PerSystem {
            macos: CommandSandboxNeeds::NOTHING,
            linux: CommandSandboxNeeds::NOTHING,
            windows: CommandSandboxNeeds::NOTHING,
        },
        memory: ProviderMemoryEstimates {
            process_bytes: 0,
            conversation_bytes: None,
        },
        standard_output_speed: "standard",
        output_speed_levels: None,
        process_environment: &[("APP_UPDATES_OFF", "1")],
        launch_environment_names: &["APP_LAUNCH"],
        credential_home_environment_names: &["APP_HOME"],
        withheld_environment_names: &["APP_WITHHELD"],
        screen_reader_environment_names: &[],
        voice_kinds: &[],
        mcp_transports: &[],
        mcp_config_members: &[],
        skill_name_max_length: None,
        background_work: None,
        callback_tools_asked: false,
        account_home_diagnostic_folders: &[],
        account_home_conversation_folders: &[],
        account_home_memory_folder: None,
        shell_prefix_command: None,
        token_limits_read_by_turn: false,
    };

    /// A second registered provider, whose credential home no row may set either, and whose
    /// background work every provider's process and conversation commands turn off.
    const OTHER_DESCRIPTOR: ProviderDescriptor = ProviderDescriptor {
        id: "second",
        process_environment: &[],
        launch_environment_names: &[],
        credential_home_environment_names: &["OTHER_HOME"],
        withheld_environment_names: &[],
        background_work: Some(BackgroundWork {
            subcommands: &["daemon"],
            flags: &[],
            refusal: "refused",
            off_switch: ("OTHER_BACKGROUND_OFF", "1"),
        }),
        ..DESCRIPTOR
    };

    fn pairs(entries: &[(&str, &str)]) -> Vec<(String, String)> {
        entries
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect()
    }

    fn rows(entries: &[(&str, &str)]) -> Vec<EnvironmentRow> {
        entries
            .iter()
            .map(|(name, value)| EnvironmentRow {
                name: BoundedText::new((*name).to_owned()).expect("the test's name is bounded"),
                value: NulFreeText::new((*value).to_owned()).expect("the test's value has no NUL"),
            })
            .collect()
    }

    fn reserved() -> ReservedEnvironmentNames {
        ReservedEnvironmentNames::of_providers(&[&DESCRIPTOR, &OTHER_DESCRIPTOR])
    }

    fn value<'e>(environment: &'e [(String, String)], name: &str) -> Option<&'e str> {
        PathRules::Posix.environment_value(environment, name)
    }

    #[test]
    fn denied_and_withheld_names_reach_no_provider_and_a_project_command_keeps_them() {
        let base = pairs(&[
            ("NPM_TOKEN", "from-shell"),
            ("APP_WITHHELD", "1"),
            ("APP_UPDATES_OFF", "0"),
        ]);
        let every_project_rows = rows(&[("NPM_TOKEN", "from-row")]);
        let reserved_names = reserved();
        let request = ProviderEnvironmentRequest {
            session: SessionEnvironment {
                base: &base,
                every_project_rows: &every_project_rows,
                project_rows: &[],
                reserved_names: &reserved_names,
                rules: PathRules::Posix,
            },
            descriptor: &DESCRIPTOR,
            deny_env_vars: &["NPM_TOKEN"],
            credential_homes: &[],
        };

        let process = build_provider_process_environment(&request, &[])
            .expect("the provider's environment builds");
        let commands = build_conversation_command_environment(&request)
            .expect("the conversation's command environment builds");
        let project = build_project_command_environment(&request.session);

        for environment in [&process, &commands] {
            assert_eq!(value(environment, "NPM_TOKEN"), None);
            assert_eq!(value(environment, "APP_WITHHELD"), None);
        }
        // The opt-out holds over the shell's own value, on the process alone.
        assert_eq!(value(&process, "APP_UPDATES_OFF"), Some("1"));
        assert_eq!(value(&commands, "APP_UPDATES_OFF"), Some("0"));
        assert_eq!(value(&project, "NPM_TOKEN"), Some("from-row"));
        assert_eq!(value(&project, "APP_WITHHELD"), Some("1"));
    }

    // Killed by setting the switch only on its own provider's process, by leaving it off the
    // conversation's commands, by setting it on the person's project command, or by letting a row
    // clear it.
    #[test]
    fn every_providers_background_switch_reaches_each_provider_and_never_a_project_command() {
        let base = pairs(&[("OTHER_BACKGROUND_OFF", "0")]);
        let project_rows = rows(&[("OTHER_BACKGROUND_OFF", "0")]);
        let reserved_names = reserved();
        let request = ProviderEnvironmentRequest {
            session: SessionEnvironment {
                base: &base,
                every_project_rows: &[],
                project_rows: &project_rows,
                reserved_names: &reserved_names,
                rules: PathRules::Posix,
            },
            descriptor: &DESCRIPTOR,
            deny_env_vars: &[],
            credential_homes: &[],
        };

        let process = build_provider_process_environment(&request, &[])
            .expect("the provider's environment builds");
        let commands = build_conversation_command_environment(&request)
            .expect("the conversation's command environment builds");
        let project = build_project_command_environment(&request.session);

        assert_eq!(value(&process, "OTHER_BACKGROUND_OFF"), Some("1"));
        assert_eq!(value(&commands, "OTHER_BACKGROUND_OFF"), Some("1"));
        assert_eq!(value(&project, "OTHER_BACKGROUND_OFF"), Some("0"));
        let row_dropped = SessionEnvironment {
            base: &[],
            ..request.session
        };
        assert_eq!(
            value(
                &build_project_command_environment(&row_dropped),
                "OTHER_BACKGROUND_OFF"
            ),
            None
        );
    }

    #[rstest]
    #[case::windows_folds_case(PathRules::Windows, None)]
    #[case::posix_keeps_case(PathRules::Posix, Some("/usr/bin"))]
    fn a_denied_name_is_matched_under_the_places_rules(
        #[case] rules: PathRules,
        #[case] remaining_path: Option<&str>,
    ) {
        let base = pairs(&[("path", "/usr/bin")]);
        let reserved_names = reserved();
        let request = ProviderEnvironmentRequest {
            session: SessionEnvironment {
                base: &base,
                every_project_rows: &[],
                project_rows: &[],
                reserved_names: &reserved_names,
                rules,
            },
            descriptor: &DESCRIPTOR,
            deny_env_vars: &["PATH"],
            credential_homes: &[],
        };

        let process = build_provider_process_environment(&request, &[])
            .expect("the provider's environment builds");

        assert_eq!(
            PathRules::Posix.environment_value(&process, "path"),
            remaining_path
        );
    }

    #[test]
    fn a_project_row_beats_every_project_and_reserved_rows_are_dropped() {
        let base = pairs(&[("APP_HOME", "/accounts/shell")]);
        let every_project_rows = rows(&[("EDITOR", "vi"), ("OTHER_HOME", "/accounts/row")]);
        let project_rows = rows(&[
            ("EDITOR", "nano"),
            ("APP_HOME", "/accounts/row"),
            ("APP_LAUNCH", "row"),
            (APP_SET_ENVIRONMENT_NAMES[0], "row"),
        ]);
        let reserved_names = reserved();
        let session = SessionEnvironment {
            base: &base,
            every_project_rows: &every_project_rows,
            project_rows: &project_rows,
            reserved_names: &reserved_names,
            rules: PathRules::Posix,
        };

        let project = build_project_command_environment(&session);

        assert_eq!(value(&project, "EDITOR"), Some("nano"));
        assert_eq!(value(&project, "APP_HOME"), Some("/accounts/shell"));
        assert_eq!(value(&project, "OTHER_HOME"), None);
        assert_eq!(value(&project, "APP_LAUNCH"), None);
        assert_eq!(value(&project, APP_SET_ENVIRONMENT_NAMES[0]), None);
    }

    #[test]
    fn a_mandated_pair_beats_the_base_and_every_row() {
        let base = pairs(&[("APP_HOME", "/accounts/shell"), ("TRACE_ADDRESS", "base")]);
        let project_rows = rows(&[("TRACE_ADDRESS", "row")]);
        let credential_homes = pairs(&[("APP_HOME", "/accounts/work")]);
        let reserved_names = reserved();
        let request = ProviderEnvironmentRequest {
            session: SessionEnvironment {
                base: &base,
                every_project_rows: &[],
                project_rows: &project_rows,
                reserved_names: &reserved_names,
                rules: PathRules::Posix,
            },
            descriptor: &DESCRIPTOR,
            deny_env_vars: &[],
            credential_homes: &credential_homes,
        };

        let process =
            build_provider_process_environment(&request, &pairs(&[("TRACE_ADDRESS", "mandated")]))
                .expect("the provider's environment builds");

        assert_eq!(value(&process, "APP_HOME"), Some("/accounts/work"));
        assert_eq!(value(&process, "TRACE_ADDRESS"), Some("mandated"));
    }

    #[rstest]
    #[case::equal_mandated_values(
        &[],
        &[],
        &[("APP_UPDATES_OFF", "1")],
        SpawnEnvironmentError::MandatedNameConflict {
            name: "APP_UPDATES_OFF".to_owned(),
            claimed_as: "APP_UPDATES_OFF".to_owned(),
        }
    )]
    #[case::relative_account_folder(
        &[],
        &[("APP_HOME", "accounts/work")],
        &[],
        SpawnEnvironmentError::AccountFolderNotAbsolute { name: "APP_HOME".to_owned() }
    )]
    #[case::empty_account_folder_given(
        &[],
        &[("APP_HOME", "")],
        &[],
        SpawnEnvironmentError::AccountFolderNotAbsolute { name: "APP_HOME".to_owned() }
    )]
    #[case::empty_account_folder_inherited(
        &[("APP_HOME", "")],
        &[],
        &[],
        SpawnEnvironmentError::AccountFolderEmpty { name: "APP_HOME".to_owned() }
    )]
    fn a_provider_environment_is_refused(
        #[case] base: &[(&str, &str)],
        #[case] credential_homes: &[(&str, &str)],
        #[case] additional_mandated_pairs: &[(&str, &str)],
        #[case] refusal: SpawnEnvironmentError,
    ) {
        let base = pairs(base);
        let credential_homes = pairs(credential_homes);
        let reserved_names = reserved();
        let request = ProviderEnvironmentRequest {
            session: SessionEnvironment {
                base: &base,
                every_project_rows: &[],
                project_rows: &[],
                reserved_names: &reserved_names,
                rules: PathRules::Posix,
            },
            descriptor: &DESCRIPTOR,
            deny_env_vars: &[],
            credential_homes: &credential_homes,
        };

        assert_eq!(
            build_provider_process_environment(&request, &pairs(additional_mandated_pairs)),
            Err(refusal)
        );
    }
}
