//! Reading and editing Claude Code's settings files. A read the daemon only consults takes a file
//! that is absent, not the daemon's to read, or not a settings object as setting nothing. The
//! managed settings, which Claude Code ranks above every other file, are read the one way Claude
//! Code merges them, and one key is read across every file in Claude Code's own precedence. An
//! edit holds the file's lock across its read and write, changes the file in place with every
//! other byte kept, and refuses a file that is not a strict JSON object, never overwriting it.

use std::ffi::OsString;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use jsonc_parser::ParseOptions;
use jsonc_parser::cst::{CstInputValue, CstObject, CstRootNode};
use serde::de::IgnoredAny;
use serde_json::{Map, Value};
use sidekicks_platforms::PathRules;
use sidekicks_std::file::atomic_write::{AtomicWriteError, rewrite_file_in_place};
use sidekicks_std::file::real_location::resolve_real_location;
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};
use sidekicks_std::missing_entry::MissingEntry;
use sidekicks_std::settle_all::{SettleFailures, settle_all};

use crate::driver::claude::session::rules::{
    CLAUDE_SHARED_SETTINGS_FILE, ClaudeProjectFolder, list_claude_local_settings_files,
    settings_path,
};
use crate::inbound_json::decode_inbound_json;
use crate::project_rule_folders::RuleFileHolds;

// Held on a settings file the daemon edits across its read and write, so two edits never drop each
// other's.
static SETTINGS_FILE_LOCK: LazyLock<KeyedLock<PathBuf>> = LazyLock::new(KeyedLock::new);

// The administrator's base settings file in the managed folder.
const MANAGED_SETTINGS_FILE: &str = "managed-settings.json";
// The folder of drop-ins that apply over the base file, in the managed folder.
const MANAGED_SETTINGS_DROP_IN_FOLDER: &str = "managed-settings.d";

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
    pub(crate) project_folder: ClaudeProjectFolder<'a>,
    /// The person's own home folder, which places the project's local file.
    pub(crate) home_folder: &'a Path,
    /// The account home's own settings file, `settings.json` in its config folder.
    pub(crate) account_settings_file: &'a Path,
    /// How the place the session runs in spells paths.
    pub(crate) path_rules: PathRules,
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

/// Fails with the first of `failures` as a settings file's read failure, for a caller that cannot
/// go on past a managed file it could not read; `Ok` where there is none.
pub(crate) fn refuse_unread_settings(
    failures: Vec<ClaudeSettingsReadError>,
) -> Result<(), ClaudeSettingsFileError> {
    match failures.into_iter().next() {
        Some(unread) => Err(ClaudeSettingsFileError::Read {
            path: unread.path,
            failure: unread.failure,
        }),
        None => Ok(()),
    }
}

/// The settings files of one tier that hold a settings object, each read once, in the order Claude
/// Code applies them, and every file or folder that could not be read.
#[derive(Debug, Default)]
pub(crate) struct ClaudeSettingsFiles {
    /// Each file that holds a settings object, with that object.
    pub(crate) files: Vec<(PathBuf, Map<String, Value>)>,
    /// What could not be read.
    pub(crate) failures: Vec<ClaudeSettingsReadError>,
}

impl ClaudeSettingsFiles {
    /// The value at `key_path` in force as Claude Code merges the files, key by key: the last
    /// file whose value `select` takes decides, with that file; `None` where no file sets it.
    pub(crate) fn find<Setting>(
        &self,
        key_path: &[&str],
        select: impl Fn(&Value) -> Option<Setting>,
    ) -> Option<ClaudeManagedSetting<Setting>> {
        self.files.iter().rev().find_map(|(file, settings)| {
            let value = find_claude_setting(settings, key_path).and_then(&select)?;
            Some(ClaudeManagedSetting {
                file: file.clone(),
                value,
            })
        })
    }
}

/// Reads each of `files` once, in order. A file the daemon cannot read, or one holding no settings
/// object, sets nothing; any other read failure is kept beside the files read.
pub(crate) async fn read_claude_settings_files(files: Vec<PathBuf>) -> ClaudeSettingsFiles {
    let mut read = ClaudeSettingsFiles::default();
    for file in files {
        match read_claude_settings_file(&file).await {
            Ok(Some(settings)) => read.files.push((file, settings)),
            Ok(None) => {}
            Err(failure) => read.failures.push(ClaudeSettingsReadError {
                path: file,
                failure,
            }),
        }
    }
    read
}

/// Reads the managed settings in `managed_settings_folder` once: `managed-settings.json`, then each
/// `managed-settings.d/*.json` in name order, JavaScript's, by UTF-16 code units, as
/// [`read_claude_settings_files`] reads them. A drop-in folder that cannot be listed is kept
/// among the failures, ahead of the files'.
pub(crate) async fn read_claude_managed_settings(
    managed_settings_folder: &Path,
) -> ClaudeSettingsFiles {
    let mut failures = Vec::new();
    let files = list_managed_settings_files(managed_settings_folder, &mut failures).await;
    let read = read_claude_settings_files(files).await;
    failures.extend(read.failures);
    ClaudeSettingsFiles {
        files: read.files,
        failures,
    }
}

/// Reads one key from the managed settings in `managed_settings_folder` as Claude Code merges
/// them, the last file whose value `select` takes deciding, as [`read_claude_managed_settings`]
/// reads the files. Any read failure is returned beside the answer.
pub(crate) async fn read_claude_managed_setting<Setting>(
    managed_settings_folder: &Path,
    key_path: &[&str],
    select: impl Fn(&Value) -> Option<Setting>,
) -> ClaudeManagedSettingRead<Setting> {
    let managed = read_claude_managed_settings(managed_settings_folder).await;
    ClaudeManagedSettingRead {
        deciding: managed.find(key_path, select),
        failures: managed.failures,
    }
}

/// The managed files in `managed_settings_folder` in the order Claude Code applies them: the base
/// file, then the drop-ins named `*.json` in JavaScript's name order. A drop-in folder the daemon
/// cannot list adds none, and its failure is pushed onto `failures`.
#[expect(
    clippy::case_sensitive_file_extension_comparisons,
    reason = "Claude Code reads a drop-in only when its name ends in `.json`, in this spelling"
)]
pub(crate) async fn list_managed_settings_files(
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
    let mut files: Vec<_> = list_claude_local_settings_files(
        &sources.project_folder,
        sources.home_folder,
        sources.path_rules,
    )
    .into_iter()
    .map(|file| (ClaudeSettingsSource::Project, file))
    .collect();
    files.push((
        ClaudeSettingsSource::Project,
        settings_path(
            sources.project_folder.working_folder,
            CLAUDE_SHARED_SETTINGS_FILE,
        ),
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

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use rstest::rstest;
    use serde_json::Value;
    use sidekicks_platforms::PathRules;

    use super::{
        ClaudeSettingsSource, ClaudeSettingsSources, read_claude_managed_setting,
        read_claude_setting,
    };
    use crate::driver::claude::session::memory::CLAUDE_AUTO_MEMORY_SETTING;
    use crate::driver::claude::session::rules::{
        CLAUDE_SHARED_SETTINGS_FILE, CLAUDE_USER_SETTINGS_FILE, ClaudeProjectFolder,
        local_settings_path, settings_path,
    };

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
    // the shared file read before the local one, by the account read before the shared file or
    // the shared file tagged as the person's, which would start a cloned project's
    // `bypassPermissions` at YOLO, or by a reader that answers a default where no file sets the
    // key.
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
    #[case::local_over_shared(
        None,
        Some(r#"{"autoMemoryEnabled": true}"#),
        Some(r#"{"autoMemoryEnabled": false}"#),
        None,
        Some((ClaudeSettingsSource::Project, true)),
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
        let account_settings_file = scratch
            .path()
            .join("account")
            .join(CLAUDE_USER_SETTINGS_FILE);
        fs::create_dir_all(&managed_folder).expect("the managed folder is made");
        fs::create_dir_all(&working_folder).expect("the working folder is made");
        write_settings(&managed_folder.join("managed-settings.json"), managed);
        write_settings(&local_settings_path(&working_folder), local);
        write_settings(
            &settings_path(&working_folder, CLAUDE_SHARED_SETTINGS_FILE),
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
                project_folder,
                home_folder: &home_folder,
                account_settings_file: &account_settings_file,
                path_rules: PathRules::NATIVE,
            },
            &[CLAUDE_AUTO_MEMORY_SETTING],
            Value::as_bool,
        )
        .await
        .expect("every settings file reads");

        assert_eq!(setting, expected);
    }

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
