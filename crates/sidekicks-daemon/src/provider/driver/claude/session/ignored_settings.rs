//! The managed settings Claude Code ranks above every other file, read the one way Claude Code
//! merges them, and the check that a process kept the retention the daemon set, read back after
//! each spawn: a lower value comes from a setting that outranks the daemon's, so the session's
//! notice names the managed file whose value is in force, where the daemon can read one that sets
//! it.

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::session::controls::events::{
    SettingsIgnoredAtKeyNotice, SettingsIgnoredKind,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::ComposedText;

use crate::provider::driver::claude::DESCRIPTOR;
use crate::provider::driver::claude::session::settings_file::{
    is_unreadable_path, read_claude_settings_file,
};
use crate::provider::driver::claude::spawn::settings::CLAUDE_CLEANUP_PERIOD_DAYS;

/// The administrator's base settings file in the managed folder.
pub(crate) const MANAGED_SETTINGS_FILE: &str = "managed-settings.json";
// The folder of drop-ins that apply over the base file, in the managed folder.
const MANAGED_SETTINGS_DROP_IN_FOLDER: &str = "managed-settings.d";

// The retention key, as Claude Code's settings and the notice name it.
const CLEANUP_PERIOD_DAYS_KEY: &str = "cleanupPeriodDays";

/// A Claude Code settings file or folder the daemon could not read for a reason other than its
/// absence or its permissions, which mean it sets nothing the daemon can name.
#[derive(Debug, thiserror::Error)]
#[error("reading the Claude Code settings at {} failed", .path.display())]
pub(crate) struct ClaudeSettingsReadError {
    /// The file or folder.
    pub(crate) path: PathBuf,
    /// The system's failure.
    #[source]
    pub(crate) failure: io::Error,
}

/// The managed file whose value of one key is in force, and that value.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ClaudeManagedSetting<Setting> {
    /// The file.
    pub(crate) file: PathBuf,
    /// Its value of the key.
    pub(crate) value: Setting,
}

/// What the managed settings say of one key: the file in force, `None` where no readable file
/// sets it, and every file or folder that could not be read, which may have set it too.
#[derive(Debug)]
pub(crate) struct ClaudeManagedSettingRead<Setting> {
    /// The file in force.
    pub(crate) deciding: Option<ClaudeManagedSetting<Setting>>,
    /// What could not be read.
    pub(crate) failures: Vec<ClaudeSettingsReadError>,
}

/// The `settings_ignored` notice for a session whose process lowered the daemon's retention, and
/// every managed file or folder that could not be read while naming the file in force.
#[derive(Debug)]
pub(crate) struct ClaudeIgnoredSettingCheck {
    /// The notice, `None` when the process kept the retention or reported none.
    pub(crate) notice: Option<SettingsIgnoredAtKeyNotice>,
    /// What could not be read; the notice goes regardless, naming no file.
    pub(crate) failures: Vec<ClaudeSettingsReadError>,
}

/// The value at `key_path` in one settings object, each key one level deeper, or `None` where
/// the object does not reach it.
pub(crate) fn find_claude_setting<'settings>(
    settings: &'settings Map<String, Value>,
    key_path: &[&str],
) -> Option<&'settings Value> {
    let (first, rest) = key_path.split_first()?;
    rest.iter()
        .try_fold(settings.get(*first)?, |value, key| value.get(*key))
}

/// Reads one key from the managed settings in `managed_settings_folder` as Claude Code merges
/// them: `managed-settings.json`, then each `managed-settings.d/*.json` in name order, the last
/// file whose value `select` takes deciding. Name order is JavaScript's, by UTF-16 code units. A
/// missing file or folder sets nothing; any other read failure is returned beside the answer.
pub(crate) async fn read_claude_managed_setting<Setting>(
    managed_settings_folder: &Path,
    key_path: &[&str],
    select: impl Fn(&Value) -> Option<Setting>,
) -> ClaudeManagedSettingRead<Setting> {
    let mut failures = Vec::new();
    let mut deciding = None;
    for file in list_managed_settings_files(managed_settings_folder, &mut failures).await {
        match read_claude_settings_file(&file).await {
            Ok(settings) => {
                let value = settings
                    .as_ref()
                    .and_then(|settings| find_claude_setting(settings, key_path))
                    .and_then(&select);
                if let Some(value) = value {
                    deciding = Some(ClaudeManagedSetting { file, value });
                }
            }
            Err(failure) => failures.push(ClaudeSettingsReadError {
                path: file,
                failure,
            }),
        }
    }
    ClaudeManagedSettingRead { deciding, failures }
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
        }),
        failures,
    }
}

// The managed files in the order Claude Code applies them: the base file, then the drop-ins named
// `*.json` in JavaScript's name order. A drop-in folder the daemon cannot list adds none.
#[expect(
    clippy::case_sensitive_file_extension_comparisons,
    reason = "Claude Code reads a drop-in only when its name ends in `.json`, in this spelling"
)]
async fn list_managed_settings_files(
    managed_settings_folder: &Path,
    failures: &mut Vec<ClaudeSettingsReadError>,
) -> Vec<PathBuf> {
    let drop_in_folder = managed_settings_folder.join(MANAGED_SETTINGS_DROP_IN_FOLDER);
    let mut names: Vec<OsString> = Vec::new();
    match tokio::fs::read_dir(&drop_in_folder).await {
        Ok(mut entries) => loop {
            match entries.next_entry().await {
                Ok(Some(entry)) => {
                    let name = entry.file_name();
                    if name.to_str().is_some_and(|name| name.ends_with(".json")) {
                        names.push(name);
                    }
                }
                Ok(None) => break,
                Err(failure) => {
                    failures.push(ClaudeSettingsReadError {
                        path: drop_in_folder.clone(),
                        failure,
                    });
                    break;
                }
            }
        },
        Err(failure) if is_unreadable_path(&failure) => {}
        Err(failure) => failures.push(ClaudeSettingsReadError {
            path: drop_in_folder.clone(),
            failure,
        }),
    }
    // JavaScript sorts text by UTF-16 code units, which orders a character past U+FFFF before one
    // in U+E000 to U+FFFF, where Rust's byte order puts it after.
    names.sort_by(|left, right| {
        let (left, right) = (left.to_string_lossy(), right.to_string_lossy());
        left.encode_utf16().cmp(right.encode_utf16())
    });
    std::iter::once(managed_settings_folder.join(MANAGED_SETTINGS_FILE))
        .chain(names.into_iter().map(|name| drop_in_folder.join(name)))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::Value;

    use super::read_claude_managed_setting;

    // Killed by sorting the drop-ins in Rust's byte order, which applies the U+FF5E file first and
    // lets the other decide.
    #[tokio::test]
    async fn drop_ins_apply_in_javascripts_name_order() {
        let managed = tempfile::tempdir().expect("a scratch folder");
        let drop_ins = managed.path().join("managed-settings.d");
        fs::create_dir(&drop_ins).expect("the drop-in folder is made");
        fs::write(
            drop_ins.join("\u{1F600}.json"),
            r#"{"cleanupPeriodDays": 10}"#,
        )
        .expect("the first drop-in is written");
        fs::write(
            drop_ins.join("\u{FF5E}.json"),
            r#"{"cleanupPeriodDays": 20}"#,
        )
        .expect("the second drop-in is written");

        let read =
            read_claude_managed_setting(managed.path(), &["cleanupPeriodDays"], Value::as_f64)
                .await;

        let deciding = read.deciding.expect("a drop-in sets the key");
        assert_eq!(deciding.file, drop_ins.join("\u{FF5E}.json"));
        assert!((deciding.value - 20.0).abs() < f64::EPSILON);
        assert!(read.failures.is_empty());
    }
}
