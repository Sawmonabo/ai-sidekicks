//! Reading and editing Claude Code's settings files. A read the daemon only consults takes a file
//! that is absent, not the daemon's to read, or not a settings object as setting nothing; one key is
//! read across every file in Claude Code's own precedence. An edit holds the file's lock across its
//! read and write, changes the file in place with every other byte kept, and refuses a file that is
//! not a strict JSON object, never overwriting it.

use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use jsonc_parser::ParseOptions;
use jsonc_parser::cst::{CstInputValue, CstObject, CstRootNode};
use serde::de::IgnoredAny;
use serde_json::{Map, Value};
use sidekicks_platforms::PathRules;
use sidekicks_std::file::atomic_write::{AtomicWriteError, write_file_atomically};
use sidekicks_std::file::real_location::resolve_real_location;
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};
use sidekicks_std::missing_entry::MissingEntry;
use sidekicks_std::settle_all::{SettleFailures, settle_all};

use crate::driver::claude::session::ignored_settings::{
    ClaudeSettingsReadError, find_claude_setting, read_claude_managed_setting,
};
use crate::driver::claude::session::rules::{
    CLAUDE_SHARED_SETTINGS_FILE, ClaudeProjectFolder, local_settings_path,
    resolve_claude_local_settings_file, settings_path,
};
use crate::inbound_json::decode_inbound_json;

// Held on a settings file the daemon edits across its read and write, so two edits never drop each
// other's.
static SETTINGS_FILE_LOCK: LazyLock<KeyedLock<PathBuf>> = LazyLock::new(KeyedLock::new);

/// Why one of Claude Code's settings files could not be read, edited or written. No variant quotes
/// the file's text, which can hold tokens.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ClaudeSettingsFileError {
    /// The file is not a strict JSON object of the shape the edit needs, so it is left as it is.
    #[error(
        "{} is not a settings object the daemon can edit, so it was left as it is",
        path.display()
    )]
    Refused {
        /// The settings file.
        path: PathBuf,
    },
    /// The file could not be read.
    #[error("reading {} failed", path.display())]
    Read {
        /// The settings file.
        path: PathBuf,
        /// The file system's failure.
        #[source]
        failure: io::Error,
    },
    /// The file's folder could not be made.
    #[error("making the folder of {} failed", path.display())]
    CreateFolder {
        /// The settings file.
        path: PathBuf,
        /// The file system's failure.
        #[source]
        failure: io::Error,
    },
    /// The file could not be written.
    #[error("writing the settings file {} failed", path.display())]
    Write {
        /// The settings file.
        path: PathBuf,
        /// The crash-safe write's failure, boxed so the error stays small.
        #[source]
        failure: Box<AtomicWriteError>,
    },
}

/// Which tier of Claude Code's settings set a key: Claude Code takes some values only from a file
/// the person or an administrator controls, never from the project's own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeSettingsSource {
    /// An administrator's managed file.
    Managed,
    /// The project's local or shared file.
    Project,
    /// The person's own file.
    Person,
}

/// Where a session's Claude Code settings are read from: the administrator's managed folder, the
/// session's working folder with what places its local file, and the account home's own settings
/// file.
pub(crate) struct ClaudeSettingsSources<'a> {
    /// The folder Claude Code reads an administrator's settings from; `None` where it names none.
    pub(crate) managed_settings_folder: Option<&'a Path>,
    /// The session's working folder, with what Claude Code reads to place its local settings.
    pub(crate) project_folder: &'a ClaudeProjectFolder<'a>,
    /// The person's own home folder, which places the project's local file.
    pub(crate) home_folder: &'a Path,
    /// The account home's own settings file, `settings.json` in its config folder.
    pub(crate) account_settings_file: &'a Path,
    /// How the place the session runs in spells paths.
    pub(crate) path_rules: PathRules,
}

/// Whether a file-system failure means the daemon cannot read the path, rather than a fault: the
/// path is absent, runs through a file, or is not the daemon's to read.
pub(crate) fn is_unreadable_path(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        ErrorKind::NotFound | ErrorKind::NotADirectory | ErrorKind::PermissionDenied
    )
}

/// One settings file as its JSON object, or `None` when the daemon cannot read it or it holds no
/// settings object. Returns any other read failure.
pub(crate) async fn read_claude_settings_file(
    file_path: &Path,
) -> io::Result<Option<Map<String, Value>>> {
    let bytes = match tokio::fs::read(file_path).await {
        Ok(bytes) => bytes,
        Err(error) if is_unreadable_path(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    // A file that is not JSON sets nothing, as one holding some other JSON value does.
    let parsed = serde_json::from_str::<Value>(&decode_inbound_json(&bytes));
    if let Ok(Value::Object(settings)) = parsed {
        return Ok(Some(settings));
    }
    Ok(None)
}

/// The first value `select` takes at `key_path` and the tier that set it, in Claude Code's own
/// precedence: the managed settings, then the project's local files, its shared file, then the
/// account home's own; `None` where no file sets it. Fails with every settings file that could not
/// be read, since it may have set the key.
pub(crate) async fn read_claude_setting<Setting>(
    sources: &ClaudeSettingsSources<'_>,
    key_path: &[&str],
    select: impl Fn(&Value) -> Option<Setting>,
) -> Result<Option<(ClaudeSettingsSource, Setting)>, SettleFailures<ClaudeSettingsReadError>> {
    if let Some(managed_settings_folder) = sources.managed_settings_folder {
        let managed = read_claude_managed_setting(managed_settings_folder, key_path, &select).await;
        settle_all(
            managed
                .failures
                .into_iter()
                .map(Err)
                .collect::<Vec<Result<(), _>>>(),
            "reading Claude Code's managed settings",
        )?;
        if let Some(setting) = managed.deciding {
            return Ok(Some((ClaudeSettingsSource::Managed, setting.value)));
        }
    }
    let working_folder = sources.project_folder.working_folder;
    let local_settings = resolve_claude_local_settings_file(
        sources.project_folder,
        sources.home_folder,
        sources.path_rules,
    )
    .path;
    let working_local_settings = local_settings_path(working_folder);
    let mut files = vec![(ClaudeSettingsSource::Project, local_settings.clone())];
    // Claude Code reads the folder's own local file too where it keeps the project's elsewhere.
    if working_local_settings != local_settings {
        files.push((ClaudeSettingsSource::Project, working_local_settings));
    }
    files.push((
        ClaudeSettingsSource::Project,
        settings_path(working_folder, CLAUDE_SHARED_SETTINGS_FILE),
    ));
    files.push((
        ClaudeSettingsSource::Person,
        sources.account_settings_file.to_path_buf(),
    ));
    for (source, file) in files {
        let settings = read_claude_settings_file(&file).await.map_err(|failure| {
            SettleFailures::One(ClaudeSettingsReadError {
                path: file.clone(),
                failure,
            })
        })?;
        let value = settings
            .as_ref()
            .and_then(|settings| find_claude_setting(settings, key_path))
            .and_then(&select);
        if let Some(value) = value {
            return Ok(Some((source, value)));
        }
    }
    Ok(None)
}

/// Waits for the edit lock on `file`, keyed by its real location so every spelling of the file
/// takes one lock, and returns the hold the edit's read and write take. Fails with `Read` when the
/// location cannot be resolved.
pub(crate) async fn hold_settings_file(
    file: &Path,
) -> Result<KeyHold<'static, PathBuf>, ClaudeSettingsFileError> {
    let key =
        resolve_real_location(file)
            .await
            .map_err(|failure| ClaudeSettingsFileError::Read {
                path: file.to_path_buf(),
                failure,
            })?;
    Ok(SETTINGS_FILE_LOCK.acquire(key).await)
}

/// The text of `file`, whose edit lock `_hold` holds, or `None` where there is no file. Fails with
/// `Read`.
pub(crate) async fn read_settings_file(
    _hold: &KeyHold<'_, PathBuf>,
    file: &Path,
) -> Result<Option<String>, ClaudeSettingsFileError> {
    tokio::fs::read_to_string(file)
        .await
        .none_if_missing()
        .map_err(|failure| ClaudeSettingsFileError::Read {
            path: file.to_path_buf(),
            failure,
        })
}

/// Replaces `file`, whose edit lock `_hold` holds, with `text` crash-safely, a new file made with
/// `mode` less the umask and its folder made where missing. Fails with `CreateFolder` or `Write`.
pub(crate) async fn write_settings_file(
    _hold: &KeyHold<'_, PathBuf>,
    file: &Path,
    text: String,
    mode: u32,
) -> Result<(), ClaudeSettingsFileError> {
    if let Some(folder) = file.parent() {
        tokio::fs::create_dir_all(folder).await.map_err(|failure| {
            ClaudeSettingsFileError::CreateFolder {
                path: file.to_path_buf(),
                failure,
            }
        })?;
    }
    write_file_atomically(file, text, mode)
        .await
        .map_err(|failure| ClaudeSettingsFileError::Write {
            path: file.to_path_buf(),
            failure: Box::new(failure),
        })
}

/// Parses `text`, the contents of `file`, as strict JSON, hands `edit` its root object and returns
/// the edited text with every other byte kept, or `None` when `edit` reports no change. Refuses a
/// file that is not strict JSON, is blank, or whose root is not an object, as `edit` refuses.
pub(crate) fn edit_settings_object(
    file: &Path,
    text: &str,
    edit: impl FnOnce(&CstObject) -> Result<bool, ClaudeSettingsFileError>,
) -> Result<Option<String>, ClaudeSettingsFileError> {
    let refused = || ClaudeSettingsFileError::Refused {
        path: file.to_path_buf(),
    };
    // The CST parser lets comments through whatever its options say, so serde reads the file as
    // strict JSON first: Claude Code reads it with a strict parser and drops a file that fails.
    serde_json::from_str::<IgnoredAny>(text).map_err(|_parse_error| refused())?;
    let root =
        CstRootNode::parse(text, &ParseOptions::default()).map_err(|_parse_error| refused())?;
    let settings = root.object_value().ok_or_else(refused)?;
    Ok(edit(&settings)?.then(|| root.to_string()))
}

/// The text of a settings file, `None` where there is none, with its root object's `key` set to
/// `value` and every other byte kept: a file that is absent is made holding only that key. `None`
/// when the file already holds `value` there, so nothing needs writing. Refuses a file as
/// [`edit_settings_object`] does.
pub(crate) fn set_settings_value(
    file: &Path,
    text: Option<&str>,
    key: &str,
    value: &Value,
) -> Result<Option<String>, ClaudeSettingsFileError> {
    let Some(text) = text else {
        let settings = Value::Object(Map::from_iter([(key.to_owned(), value.clone())]));
        let mut created = serde_json::to_string_pretty(&settings)
            .expect("an object of JSON values always serializes");
        created.push('\n');
        return Ok(Some(created));
    };
    edit_settings_object(file, text, |settings| {
        // Claude Code reads the last of a key written twice, so that one is set.
        let property = settings
            .properties()
            .into_iter()
            .rev()
            .find(|property| property.decoded_name().as_deref() == Some(key));
        match property {
            Some(property) => {
                // The file passed the strict read, so the value's own text is strict JSON.
                let held = property
                    .value()
                    .and_then(|node| serde_json::from_str::<Value>(&node.to_string()).ok());
                if held.as_ref() == Some(value) {
                    return Ok(false);
                }
                property.set_value(cst_input_value(value));
            }
            None => {
                settings.append(key, cst_input_value(value));
            }
        }
        Ok(true)
    })
}

// A JSON value as the CST inserts it.
fn cst_input_value(value: &Value) -> CstInputValue {
    match value {
        Value::Null => CstInputValue::Null,
        Value::Bool(flag) => CstInputValue::Bool(*flag),
        Value::Number(number) => CstInputValue::Number(number.to_string()),
        Value::String(text) => CstInputValue::String(text.clone()),
        Value::Array(elements) => {
            CstInputValue::Array(elements.iter().map(cst_input_value).collect())
        }
        Value::Object(members) => CstInputValue::Object(
            members
                .iter()
                .map(|(name, member)| (name.clone(), cst_input_value(member)))
                .collect(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use rstest::rstest;
    use serde_json::Value;
    use sidekicks_platforms::PathRules;

    use super::{ClaudeSettingsSource, ClaudeSettingsSources, read_claude_setting};
    use crate::driver::claude::session::rules::ClaudeProjectFolder;

    // Writes `contents` to `file`, making its folder, where the case names one.
    fn write_settings(file: &Path, contents: Option<&str>) {
        let Some(contents) = contents else {
            return;
        };
        fs::create_dir_all(file.parent().expect("a settings file sits in a folder"))
            .expect("the settings folder is made");
        fs::write(file, contents).expect("the settings file is written");
    }

    // Killed by an account-first walk, by a dropped managed tier or one read after the files, by
    // the account read before the shared file or the shared file tagged as the person's, which
    // would start a cloned project's `bypassPermissions` at YOLO, or by a reader that answers a
    // default where no file sets the key.
    #[rstest]
    #[case::local_over_account(
        None,
        Some(r#"{"autoMemoryEnabled": true}"#),
        None,
        Some(r#"{"autoMemoryEnabled": false}"#),
        Some((ClaudeSettingsSource::Project, true)),
    )]
    #[case::managed_over_local(
        Some(r#"{"autoMemoryEnabled": false}"#),
        Some(r#"{"autoMemoryEnabled": true}"#),
        None,
        None,
        Some((ClaudeSettingsSource::Managed, false)),
    )]
    #[case::shared_over_account(
        None,
        None,
        Some(r#"{"autoMemoryEnabled": false}"#),
        Some(r#"{"autoMemoryEnabled": true}"#),
        Some((ClaudeSettingsSource::Project, false)),
    )]
    #[case::nothing_set(None, None, None, None, None)]
    #[tokio::test]
    async fn the_first_settings_file_that_sets_a_key_decides_it(
        #[case] managed: Option<&str>,
        #[case] local: Option<&str>,
        #[case] shared: Option<&str>,
        #[case] account: Option<&str>,
        #[case] expected: Option<(ClaudeSettingsSource, bool)>,
    ) {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let managed_folder = scratch.path().join("managed");
        let working_folder = scratch.path().join("work");
        let home_folder = scratch.path().join("home");
        let account_settings_file = scratch.path().join("account").join("settings.json");
        fs::create_dir_all(&managed_folder).expect("the managed folder is made");
        fs::create_dir_all(&working_folder).expect("the working folder is made");
        write_settings(&managed_folder.join("managed-settings.json"), managed);
        write_settings(
            &working_folder.join(".claude").join("settings.local.json"),
            local,
        );
        write_settings(
            &working_folder.join(".claude").join("settings.json"),
            shared,
        );
        write_settings(&account_settings_file, account);
        let project_folder = ClaudeProjectFolder {
            working_folder: &working_folder,
            repository: None,
        };

        let setting = read_claude_setting(
            &ClaudeSettingsSources {
                managed_settings_folder: Some(&managed_folder),
                project_folder: &project_folder,
                home_folder: &home_folder,
                account_settings_file: &account_settings_file,
                path_rules: PathRules::NATIVE,
            },
            &["autoMemoryEnabled"],
            Value::as_bool,
        )
        .await
        .expect("every settings file reads");

        assert_eq!(setting, expected);
    }
}
