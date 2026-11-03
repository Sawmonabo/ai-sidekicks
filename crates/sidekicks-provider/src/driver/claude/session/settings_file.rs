//! Reading and editing Claude Code's settings files. A read the daemon only consults takes a file
//! that is absent, not the daemon's to read, or not a settings object as setting nothing. An edit
//! holds the file's lock across its read and write, changes the file in place with every other byte
//! kept, and refuses a file that is not a strict JSON object, never overwriting it.

use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use jsonc_parser::ParseOptions;
use jsonc_parser::cst::{CstInputValue, CstObject, CstRootNode};
use serde::de::IgnoredAny;
use serde_json::{Map, Value};
use sidekicks_std::file::atomic_write::{AtomicWriteError, rewrite_file_in_place};
use sidekicks_std::file::real_location::resolve_real_location;
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};
use sidekicks_std::missing_entry::MissingEntry;

use crate::inbound_json::decode_inbound_json;
use crate::project_rule_folders::RuleFileHolds;

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
    /// The file could not be deleted.
    #[error("deleting the settings file {} failed", path.display())]
    Delete {
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

/// Whether a file-system failure means the daemon cannot read the path, rather than a fault: the
/// path is absent, runs through a file, or is not the daemon's to read.
pub(crate) fn is_unreadable_path(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        ErrorKind::NotFound | ErrorKind::NotADirectory | ErrorKind::PermissionDenied
    )
}

/// One settings file as read: `None` when the daemon cannot read it, else its text parsed as
/// strict JSON, the parse failure where it is not; each caller decides what a file that is not a
/// settings object means. Returns any other read failure.
pub(crate) async fn read_claude_settings_json(
    file_path: &Path,
) -> io::Result<Option<serde_json::Result<Value>>> {
    match tokio::fs::read(file_path).await {
        Ok(bytes) => Ok(Some(serde_json::from_str(&decode_inbound_json(&bytes)))),
        Err(error) if is_unreadable_path(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

/// One settings file as its JSON object, or `None` when the daemon cannot read it or it holds no
/// settings object. Returns any other read failure.
pub(crate) async fn read_claude_settings_file(
    file_path: &Path,
) -> io::Result<Option<Map<String, Value>>> {
    // A file that is not JSON sets nothing, as one holding some other JSON value does.
    if let Some(Ok(Value::Object(settings))) = read_claude_settings_json(file_path).await? {
        return Ok(Some(settings));
    }
    Ok(None)
}

/// Waits for the edit lock on `file`, keyed by its real location so every spelling of the file
/// takes one lock, and returns the hold the edit's read and write take. Fails with `Read` when the
/// location cannot be resolved.
pub(crate) async fn hold_settings_file(
    file: &Path,
) -> Result<KeyHold<'static, PathBuf>, ClaudeSettingsFileError> {
    Ok(SETTINGS_FILE_LOCK
        .acquire(settings_lock_key(file).await?)
        .await)
}

/// Waits for the edit lock on each of `files`, every file in one order as [`hold_settings_file`]
/// keys it, for a write into all of them and any take-back. Fails with `Read` where a file's
/// location cannot be resolved.
pub(crate) async fn hold_settings_files(
    files: &[PathBuf],
) -> Result<RuleFileHolds, ClaudeSettingsFileError> {
    let mut keyed_files = Vec::with_capacity(files.len());
    for file in files {
        keyed_files.push((file.clone(), settings_lock_key(file).await?));
    }
    Ok(RuleFileHolds::acquire(&SETTINGS_FILE_LOCK, keyed_files).await)
}

// A settings file as its edit lock knows it, one key for every spelling of the file.
async fn settings_lock_key(file: &Path) -> Result<PathBuf, ClaudeSettingsFileError> {
    resolve_real_location(file)
        .await
        .map_err(|failure| ClaudeSettingsFileError::Read {
            path: file.to_path_buf(),
            failure,
        })
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

/// Replaces `file`, whose edit lock `_hold` holds, with `text` crash-safely, through any link to it
/// and keeping its mode; a new file is made with `mode` less the umask and its folder made where
/// missing. Fails with `CreateFolder` or `Write`.
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
    rewrite_file_in_place(file, text, mode)
        .await
        .map_err(|failure| ClaudeSettingsFileError::Write {
            path: file.to_path_buf(),
            failure: Box::new(failure),
        })
}

/// Deletes `file`, whose edit lock `_hold` holds; a file already gone needs nothing. Fails with
/// `Delete`.
pub(crate) async fn delete_settings_file(
    _hold: &KeyHold<'_, PathBuf>,
    file: &Path,
) -> Result<(), ClaudeSettingsFileError> {
    tokio::fs::remove_file(file)
        .await
        .none_if_missing()
        .map(|_was_there| ())
        .map_err(|failure| ClaudeSettingsFileError::Delete {
            path: file.to_path_buf(),
            failure,
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
