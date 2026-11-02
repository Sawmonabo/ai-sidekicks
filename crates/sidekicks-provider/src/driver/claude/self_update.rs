//! Whether the person keeps Claude Code from updating itself, and which release channel its
//! updates follow, read from their own environment and settings files as Claude Code reads them,
//! never from the daemon's own process environment.
#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the driver's update read, which the provider section's refresh calls"
    )
)]

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use sidekicks_platforms::PathRules;

use crate::driver::claude::mcp::config::ClaudePersonConfigFiles;
use crate::driver::claude::session::ignored_settings::{
    ClaudeSettingsReadError, find_claude_setting, read_claude_managed_setting,
};
use crate::driver::claude::session::settings_file::read_claude_settings_file;

// The settings key holding the variables Claude Code writes into its environment.
const ENV_KEY: &str = "env";
// The settings key naming the release channel.
const AUTO_UPDATES_CHANNEL_KEY: &str = "autoUpdatesChannel";
// The older `.claude.json` key that turns background updates off when `false`.
const AUTO_UPDATES_KEY: &str = "autoUpdates";

/// What the person's own setup says of Claude Code's own updates.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeSelfUpdateReading {
    /// What keeps Claude Code from updating itself, `None` where nothing does.
    pub(crate) kept_from_updating: Option<ClaudeUpdateOptOut>,
    /// The release channel its updates follow.
    pub(crate) channel: ClaudeUpdateChannel,
}

/// What keeps Claude Code from updating itself, named so the section can say where it is set.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeUpdateOptOut {
    /// A variable set as Claude Code reads it.
    Variable {
        /// The variable.
        variable: ClaudeUpdateOptOutVariable,
        /// Where its deciding value was found.
        source: ClaudeVariableSource,
    },
    /// `autoUpdates: false` in the person's `.claude.json`.
    AutoUpdatesOff {
        /// The person's config file.
        person_config: PathBuf,
    },
}

/// A variable that keeps Claude Code from updating itself, named for what it turns off, in the
/// order the read checks them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeUpdateOptOutVariable {
    /// `DISABLE_UPDATES`, set when `1`: blocks every update, `claude update` included.
    AllUpdates,
    /// `DISABLE_AUTOUPDATER`, set when `1`: blocks background updates.
    BackgroundUpdates,
    /// `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, set when it holds anything, `0` included.
    NonessentialTraffic,
}

impl ClaudeUpdateOptOutVariable {
    // Every variable, in the order the read checks them.
    const ALL: [Self; 3] = [
        Self::AllUpdates,
        Self::BackgroundUpdates,
        Self::NonessentialTraffic,
    ];

    /// The variable's name, as Claude Code reads it.
    pub(crate) const fn name(self) -> &'static str {
        match self {
            Self::AllUpdates => "DISABLE_UPDATES",
            Self::BackgroundUpdates => "DISABLE_AUTOUPDATER",
            Self::NonessentialTraffic => "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
        }
    }

    // Whether `value` turns the variable on, as Claude Code reads it.
    fn is_set_by(self, value: &str) -> bool {
        match self {
            Self::AllUpdates | Self::BackgroundUpdates => value == "1",
            Self::NonessentialTraffic => !value.is_empty(),
        }
    }
}

/// Where a variable's deciding value was found: a managed settings file's `env` outranks the
/// person's `settings.json`, whose `env` outranks the login shell, as Claude Code applies them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeVariableSource {
    /// The `env` block of the administrator's managed settings file.
    ManagedSettings {
        /// The managed file.
        file: PathBuf,
    },
    /// The `env` block of the person's own `settings.json`.
    UserSettings {
        /// The settings file.
        file: PathBuf,
    },
    /// The person's login shell environment.
    LoginShell,
}

/// The release channel Claude Code's updates and its latest-version marker follow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeUpdateChannel {
    /// The most recent release, followed when the channel is unset or names no known channel.
    Latest,
    /// A release about a week old that skips major regressions.
    Stable,
}

/// Reads whether the person keeps Claude Code from updating itself, from `environment` (their
/// login shell's, as the daemon captured it), their `config_files` and the managed settings in
/// `managed_settings_folder`, and the channel its updates follow. A file that is absent or not
/// the daemon's to read sets nothing; any other read failure is returned.
pub(crate) async fn read_claude_self_update(
    environment: &[(String, String)],
    config_files: &ClaudePersonConfigFiles,
    managed_settings_folder: Option<&Path>,
) -> Result<ClaudeSelfUpdateReading, ClaudeSettingsReadError> {
    let user_settings = read_settings(&config_files.user_settings).await?;
    let mut kept_from_updating = None;
    for variable in ClaudeUpdateOptOutVariable::ALL {
        let deciding = read_deciding_variable(
            variable,
            environment,
            &config_files.user_settings,
            user_settings.as_ref(),
            managed_settings_folder,
        )
        .await?;
        if let Some((value, source)) = deciding
            && variable.is_set_by(&value)
        {
            kept_from_updating = Some(ClaudeUpdateOptOut::Variable { variable, source });
            break;
        }
    }
    if kept_from_updating.is_none() {
        // Read only when no variable decides, since the file can be large.
        let person_config = read_settings(&config_files.person_config).await?;
        let is_auto_updates_off = person_config
            .as_ref()
            .and_then(|config| find_claude_setting(config, &[AUTO_UPDATES_KEY]))
            == Some(&Value::Bool(false));
        if is_auto_updates_off {
            kept_from_updating = Some(ClaudeUpdateOptOut::AutoUpdatesOff {
                person_config: config_files.person_config.clone(),
            });
        }
    }
    let channel_word = match managed_settings_folder {
        Some(folder) => read_managed_text(folder, &[AUTO_UPDATES_CHANNEL_KEY])
            .await?
            .map(|(word, _file)| word),
        None => None,
    }
    .or_else(|| {
        user_settings
            .as_ref()
            .and_then(|settings| find_claude_setting(settings, &[AUTO_UPDATES_CHANNEL_KEY]))
            .and_then(Value::as_str)
            .map(str::to_owned)
    });
    let channel = match channel_word.as_deref() {
        Some("stable") => ClaudeUpdateChannel::Stable,
        Some(_) | None => ClaudeUpdateChannel::Latest,
    };
    Ok(ClaudeSelfUpdateReading {
        kept_from_updating,
        channel,
    })
}

// The value of `variable` Claude Code runs with and where it was found: the managed `env`, else
// the person's `settings.json` `env`, else the login shell's; `None` where none sets it.
async fn read_deciding_variable(
    variable: ClaudeUpdateOptOutVariable,
    environment: &[(String, String)],
    user_settings_file: &Path,
    user_settings: Option<&Map<String, Value>>,
    managed_settings_folder: Option<&Path>,
) -> Result<Option<(String, ClaudeVariableSource)>, ClaudeSettingsReadError> {
    let key_path = [ENV_KEY, variable.name()];
    if let Some(folder) = managed_settings_folder
        && let Some((value, file)) = read_managed_text(folder, &key_path).await?
    {
        return Ok(Some((
            value,
            ClaudeVariableSource::ManagedSettings { file },
        )));
    }
    let from_user_settings = user_settings
        .and_then(|settings| find_claude_setting(settings, &key_path))
        .and_then(Value::as_str);
    if let Some(value) = from_user_settings {
        let source = ClaudeVariableSource::UserSettings {
            file: user_settings_file.to_path_buf(),
        };
        return Ok(Some((value.to_owned(), source)));
    }
    Ok(PathRules::NATIVE
        .environment_value(environment, variable.name())
        .map(|value| (value.to_owned(), ClaudeVariableSource::LoginShell)))
}

// The text at `key_path` in the managed settings, as Claude Code merges them, and the file that
// sets it. Fails with the first managed file or folder that could not be read.
async fn read_managed_text(
    managed_settings_folder: &Path,
    key_path: &[&str],
) -> Result<Option<(String, PathBuf)>, ClaudeSettingsReadError> {
    let read = read_claude_managed_setting(managed_settings_folder, key_path, |value| {
        value.as_str().map(str::to_owned)
    })
    .await;
    if let Some(failure) = read.failures.into_iter().next() {
        return Err(failure);
    }
    Ok(read.deciding.map(|setting| (setting.value, setting.file)))
}

// One of the person's settings files, `None` where it sets nothing.
async fn read_settings(file: &Path) -> Result<Option<Map<String, Value>>, ClaudeSettingsReadError> {
    read_claude_settings_file(file)
        .await
        .map_err(|failure| ClaudeSettingsReadError {
            path: file.to_path_buf(),
            failure,
        })
}

#[cfg(test)]
mod tests;
