//! The person's own privacy choices in their Codex configuration, which every account the app
//! manages starts with, so a managed account never collects what the person turned off.

use std::path::Path;

use crate::driver::codex::config_read::{
    CODEX_CONFIG_FILE_NAME, CodexConfigFileError, read_codex_config_file,
};
use crate::driver::codex::session::errors::CodexError;

// The two tables the read takes, and the switch each holds; every other table and key is left
// unread.
const ANALYTICS_TABLE: &str = "analytics";
const FEEDBACK_TABLE: &str = "feedback";
const ENABLED_KEY: &str = "enabled";

/// The two privacy switches the person's own Codex configuration sets; `None` where it sets none.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct CodexPrivacyReading {
    analytics_enabled: Option<bool>,
    feedback_enabled: Option<bool>,
}

impl CodexPrivacyReading {
    /// The `key=value` switches that carry each choice the person set into a service's start, as
    /// read; none for a choice left unset, so Codex's own default stands there.
    pub(crate) fn config_overrides(self) -> Vec<String> {
        [
            (ANALYTICS_TABLE, self.analytics_enabled),
            (FEEDBACK_TABLE, self.feedback_enabled),
        ]
        .into_iter()
        .filter_map(|(table, value)| {
            value.map(|is_enabled| format!("{table}.{ENABLED_KEY}={is_enabled}"))
        })
        .collect()
    }
}

/// Reads the privacy choices in `config.toml` under `personal_home`, the person's own Codex folder;
/// a file that is absent sets none. Fails with `CodexError::ConfigUnreadable` naming the file,
/// never its text, when it cannot be read or does not parse, or when a privacy table or switch
/// holds a value of a type Codex refuses there.
pub(crate) async fn read_codex_privacy(
    personal_home: &Path,
) -> Result<CodexPrivacyReading, CodexError> {
    let path = personal_home.join(CODEX_CONFIG_FILE_NAME);
    let Some(config) = read_codex_config_file(&path)
        .await
        .map_err(CodexError::ConfigUnreadable)?
    else {
        return Ok(CodexPrivacyReading::default());
    };
    let mistyped = |key: String| {
        CodexError::ConfigUnreadable(CodexConfigFileError::Mistyped {
            path: path.clone(),
            key,
        })
    };
    let switch = |table_name: &str| -> Result<Option<bool>, CodexError> {
        let Some(table) = config.get(table_name) else {
            return Ok(None);
        };
        let Some(table) = table.as_table() else {
            return Err(mistyped(table_name.to_owned()));
        };
        table.get(ENABLED_KEY).map_or(Ok(None), |value| {
            value
                .as_bool()
                .map(Some)
                .ok_or_else(|| mistyped(format!("{table_name}.{ENABLED_KEY}")))
        })
    };
    Ok(CodexPrivacyReading {
        analytics_enabled: switch(ANALYTICS_TABLE)?,
        feedback_enabled: switch(FEEDBACK_TABLE)?,
    })
}

#[cfg(test)]
mod tests;
