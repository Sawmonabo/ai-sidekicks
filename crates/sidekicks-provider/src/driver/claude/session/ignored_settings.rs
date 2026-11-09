//! The check that a process kept the retention the daemon set, read back after each spawn: a
//! lower value comes from a setting that outranks the daemon's, so the session's notice names the
//! managed file whose value is in force, where the daemon can read one that sets it.

use std::path::Path;

use serde_json::Value;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::session::controls::events::{
    SettingsIgnoredAtKeyNotice, SettingsIgnoredKind,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::ComposedText;

use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::session::settings_file::{
    ClaudeSettingsReadError, read_claude_managed_setting,
};
use crate::driver::claude::spawn::settings::CLAUDE_CLEANUP_PERIOD_DAYS;

// The retention key, as Claude Code's settings and the notice name it.
const CLEANUP_PERIOD_DAYS_KEY: &str = "cleanupPeriodDays";

/// The `settings_ignored` notice for a session whose process lowered the daemon's retention, and
/// every managed file or folder that could not be read while naming the file in force.
#[derive(Debug)]
pub(crate) struct ClaudeIgnoredSettingCheck {
    /// The notice, `None` when the process kept the retention or reported none.
    pub(crate) notice: Option<SettingsIgnoredAtKeyNotice>,
    /// What could not be read; the notice goes regardless, naming no file.
    pub(crate) failures: Vec<ClaudeSettingsReadError>,
}

/// The notice for a session whose process reports `effective_cleanup_period_days` below the
/// retention the daemon set, naming the managed file in `managed_settings_folder` whose value
/// lowers it, where one does; no notice when the process kept it or reported none.
pub(crate) async fn find_ignored_setting_notice(
    session_id: SessionId,
    effective_cleanup_period_days: Option<f64>,
    managed_settings_folder: Option<&Path>,
) -> ClaudeIgnoredSettingCheck {
    let retention = f64::from(CLAUDE_CLEANUP_PERIOD_DAYS);
    let is_lowered = effective_cleanup_period_days.is_some_and(|days| days < retention);
    if !is_lowered {
        return ClaudeIgnoredSettingCheck {
            notice: None,
            failures: Vec::new(),
        };
    }
    let (deciding, failures) = match managed_settings_folder {
        Some(folder) => {
            let read =
                read_claude_managed_setting(folder, &[CLEANUP_PERIOD_DAYS_KEY], Value::as_f64)
                    .await;
            (read.deciding, read.failures)
        }
        None => (None, Vec::new()),
    };
    // The file is named only where an unread file cannot have decided the value instead, and a
    // path the wire cannot carry is named as no file.
    let file = deciding
        .filter(|setting| failures.is_empty() && setting.value < retention)
        .and_then(|setting| FilesystemPath::new(setting.file.to_string_lossy().into_owned()).ok());
    ClaudeIgnoredSettingCheck {
        notice: Some(SettingsIgnoredAtKeyNotice {
            session_id,
            kind: SettingsIgnoredKind::Value,
            provider: DESCRIPTOR.provider_id(),
            file,
            key: Some(
                ComposedText::new(CLEANUP_PERIOD_DAYS_KEY.to_owned())
                    .expect("the retention key is a word"),
            ),
            line: None,
            // The retention check reads a number back; no report gives words for it.
            text: None,
        }),
        failures,
    }
}
