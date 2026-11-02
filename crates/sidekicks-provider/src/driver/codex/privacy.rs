//! The person's own privacy choices in their Codex configuration, which every account the app
//! manages starts with, so a managed account never collects what the person turned off.

use std::io;
use std::path::Path;

use serde::Deserialize;

use crate::driver::codex::session::errors::CodexError;

/// The person's configuration file in their own Codex folder.
const CONFIG_FILE_NAME: &str = "config.toml";

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
            ("analytics.enabled", self.analytics_enabled),
            ("feedback.enabled", self.feedback_enabled),
        ]
        .into_iter()
        .filter_map(|(key, value)| value.map(|is_enabled| format!("{key}={is_enabled}")))
        .collect()
    }
}

// The only tables of the file the read takes; every other table and key is left unread.
#[derive(Default, Deserialize)]
#[serde(default)]
struct PrivacyTables {
    analytics: EnabledSwitch,
    feedback: EnabledSwitch,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct EnabledSwitch {
    enabled: Option<bool>,
}

/// Reads the privacy choices in `config.toml` under `personal_home`, the person's own Codex
/// folder; a file that is absent sets none. Fails with `CodexError::Transport` naming the file,
/// never its text, when it cannot be read or does not parse.
pub(crate) async fn read_codex_privacy(
    personal_home: &Path,
) -> Result<CodexPrivacyReading, CodexError> {
    let path = personal_home.join(CONFIG_FILE_NAME);
    let text = match tokio::fs::read_to_string(&path).await {
        Ok(text) => text,
        Err(failure) if failure.kind() == io::ErrorKind::NotFound => {
            return Ok(CodexPrivacyReading::default());
        }
        Err(failure) => {
            return Err(CodexError::Transport {
                detail: format!(
                    "Codex's configuration {} could not be read.",
                    path.display()
                ),
                cause: Some(Box::new(failure)),
            });
        }
    };
    // The parse error is dropped once its line is read: it holds the file's text and shows it.
    let tables: PrivacyTables = toml::from_str(&text).map_err(|failure| {
        let line = failure
            .span()
            .and_then(|span| text.get(..span.start))
            .map_or_else(String::new, |before| {
                format!(" at line {}", before.matches('\n').count() + 1)
            });
        CodexError::Transport {
            detail: format!(
                "Codex's configuration {} does not parse{line}.",
                path.display()
            ),
            cause: None,
        }
    })?;
    Ok(CodexPrivacyReading {
        analytics_enabled: tables.analytics.enabled,
        feedback_enabled: tables.feedback.enabled,
    })
}

#[cfg(test)]
mod tests;
