//! The guarded edit of one server's entry in Claude Code's own config, which adds the entry or
//! writes it in place, so no value ever sits on a command line. The person's config is edited
//! under Claude Code's lock, through any link to it, and lands only while the binding's entry is
//! still the one observed and the file is still the one read, or, where no file is there yet, only
//! while none is; a project's `.mcp.json`, which Claude Code writes with no lock, is read, compared
//! and written again while it keeps changing underneath. Every other member keeps its place and
//! its value.

use std::error::Error;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{Map, Value};
use sidekicks_contracts::mcp::server::McpServerName;
use sidekicks_platforms::{LeftoverSweep, create_file_atomically, flush_folder};
use sidekicks_std::error_description::describe_error;
use sidekicks_std::file::atomic_write::{AtomicWriteError, write_and_flush_while};
use sidekicks_std::file::real_location::resolve_real_location;

use super::lock::{ClaudeConfigLock, ClaudeConfigLockError, log_unremoved};
use super::observe::observed_entry;
use super::{MCP_SERVERS_MEMBER, PROJECTS_MEMBER, value_at};
use crate::driver::mcp_server::write::{
    McpServerEntry, McpServerObservedEntry, McpServerWriteOutcome, McpServerWriteRefusal,
    provider_words_without_values,
};
use crate::inbound_json::decode_inbound_json;

/// The mode the person's config is made with where it is not there yet, as Claude Code makes it:
/// read and written by its owner alone.
const PERSON_CONFIG_MODE: u32 = 0o600;

/// The mode a project's `.mcp.json` is made with where it is not there yet, as Claude Code makes
/// it: a file kept with the repository, which everyone may read.
const SERVERS_FILE_MODE: u32 = 0o644;

/// The longest the edit of the person's config runs from its stat to its rename: the least age
/// past which Claude Code's lock library reads a lock as stale, since the lock is never refreshed.
const LOCK_HOLD_MAX: Duration = Duration::from_secs(2);

/// The tries of an edit to a project's `.mcp.json` that another writer keeps changing.
const SERVERS_FILE_TRIES: usize = 5;

/// The config file an edit goes to.
#[derive(Clone, Debug)]
pub(super) enum ClaudeEditTarget {
    /// The person's own config, its `user` servers at `mcpServers` and a project's `local` ones
    /// under `projects.<project_key>.mcpServers`; edited under Claude Code's lock.
    PersonConfig {
        /// The config's path as Claude Code names it, before any link is followed.
        path: PathBuf,
        /// The project's key, its root, for a `local` server; `None` for a `user` one.
        project_key: Option<String>,
    },
    /// A project's `.mcp.json`, its servers at `mcpServers`; edited with no lock, as Claude Code
    /// edits it.
    ProjectServersFile {
        /// The file's path, before any link is followed.
        path: PathBuf,
    },
}

/// How one try of an edit ended.
enum EditTry {
    /// The edit's outcome.
    Ended(McpServerWriteOutcome),
    /// The file's size or modification time moved before the rename, so nothing was written.
    FileChanged,
}

/// Writes `entry` whole as `server_name`'s entry in `target`, in place of the one there or added
/// where there is none, the file made where it is not there yet, but only while the entry there is
/// still `before`. The person's config waits for Claude Code's lock until `deadline`. Answers
/// `Applied` once written or where the entry is already held, `Unknown` where the write's end is
/// not known, and every other end as a refusal, nothing written: the lock held or the hold past
/// its bound as `ConfigFileBusy`, the entry changed as `EntryChanged`, the file changed or made by
/// another writer as `ConfigFileChanged`.
pub(super) async fn edit_claude_mcp_entry(
    target: ClaudeEditTarget,
    server_name: &McpServerName,
    entry: &McpServerEntry,
    before: &McpServerObservedEntry,
    deadline: tokio::time::Instant,
) -> McpServerWriteOutcome {
    edit_entry(target, server_name, entry, before, deadline, || ()).await
}

// The edit, with `on_rename_due` called on each try just before its unchanged check.
async fn edit_entry<RenameDue>(
    target: ClaudeEditTarget,
    server_name: &McpServerName,
    entry: &McpServerEntry,
    before: &McpServerObservedEntry,
    deadline: tokio::time::Instant,
    on_rename_due: RenameDue,
) -> McpServerWriteOutcome
where
    RenameDue: FnOnce() + Clone + Send + 'static,
{
    let (path, project_key) = match &target {
        ClaudeEditTarget::PersonConfig { path, project_key } => (path, project_key.as_deref()),
        ClaudeEditTarget::ProjectServersFile { path } => (path, None),
    };
    let mut keys: Vec<String> = project_key
        .map(|project_key| vec![PROJECTS_MEMBER.to_owned(), project_key.to_owned()])
        .unwrap_or_default();
    keys.extend([
        MCP_SERVERS_MEMBER.to_owned(),
        server_name.as_str().to_owned(),
    ]);
    // Claude Code writes through a link to its config, so the edit goes to the link's target.
    let file = match resolve_real_location(path).await {
        Ok(file) => file,
        Err(failure) => {
            return refused_by_daemon("Claude Code's config could not be found", &failure);
        }
    };
    match target {
        ClaudeEditTarget::PersonConfig { path, .. } => {
            let lock = match ClaudeConfigLock::take(&path, deadline).await {
                Ok(lock) => lock,
                Err(ClaudeConfigLockError::Held) => {
                    return McpServerWriteOutcome::Refused(McpServerWriteRefusal::ConfigFileBusy);
                }
                Err(failure @ ClaudeConfigLockError::Folder(_)) => {
                    return refused_by_daemon("Claude Code's config could not be locked", &failure);
                }
            };
            match edit_once(
                &file,
                &keys,
                entry,
                before,
                PERSON_CONFIG_MODE,
                Some(lock),
                on_rename_due,
            )
            .await
            {
                EditTry::Ended(outcome) => outcome,
                EditTry::FileChanged => {
                    McpServerWriteOutcome::Refused(McpServerWriteRefusal::ConfigFileChanged)
                }
            }
        }
        ClaudeEditTarget::ProjectServersFile { .. } => {
            for _try in 0..SERVERS_FILE_TRIES {
                if let EditTry::Ended(outcome) = edit_once(
                    &file,
                    &keys,
                    entry,
                    before,
                    SERVERS_FILE_MODE,
                    None,
                    on_rename_due.clone(),
                )
                .await
                {
                    return outcome;
                }
            }
            McpServerWriteOutcome::Refused(McpServerWriteRefusal::ConfigFileChanged)
        }
    }
}

// One try on a blocking thread: the file read, the entry compared and the edit renamed in place,
// or the file made with `new_file_mode` where it is not there. The thread owns `lock`, where one
// is held, and releases it once the try ends, so a caller dropped meanwhile never frees the lock
// ahead of the rename.
async fn edit_once<RenameDue>(
    file: &Path,
    keys: &[String],
    entry: &McpServerEntry,
    before: &McpServerObservedEntry,
    new_file_mode: u32,
    lock: Option<ClaudeConfigLock>,
    on_rename_due: RenameDue,
) -> EditTry
where
    RenameDue: FnOnce() + Send + 'static,
{
    let (file, keys, edited, before) = (
        file.to_path_buf(),
        keys.to_vec(),
        Value::Object(entry.members().clone()),
        before.clone(),
    );
    match tokio::task::spawn_blocking(move || {
        let tried = edit_file(
            &file,
            &keys,
            edited,
            &before,
            new_file_mode,
            lock.as_ref().map(|_held| LOCK_HOLD_MAX),
            on_rename_due,
        );
        // The write stands whether or not the lock's folder goes.
        if let Some(lock) = lock {
            log_unremoved(lock.release());
        }
        tried
    })
    .await
    {
        Ok(tried) => tried,
        Err(failure) => {
            // The task may have ended after the rename.
            tracing::warn!(
                error = &failure as &(dyn Error + 'static),
                "the edit of Claude Code's config ended before it finished"
            );
            EditTry::Ended(McpServerWriteOutcome::Unknown)
        }
    }
}

// One try on the calling thread. The hold runs from the stat to the rename, or to the making of
// a file not there, and is bounded by `hold_max` where given, checked before the rename and never
// after it.
fn edit_file(
    file: &Path,
    keys: &[String],
    edited: Value,
    before: &McpServerObservedEntry,
    new_file_mode: u32,
    hold_max: Option<Duration>,
    on_rename_due: impl FnOnce(),
) -> EditTry {
    let hold_started = Instant::now();
    let is_hold_past_bound = || hold_max.is_some_and(|hold_max| hold_started.elapsed() > hold_max);
    let read = fs::metadata(file).and_then(|stat| {
        let modified = stat.modified()?;
        Ok((stat.len(), modified, fs::read(file)?))
    });
    // The size and modification time of the file read, and its bytes; `None` where no file is
    // there yet.
    let (held_stat, bytes) = match read {
        Ok((held_length, held_modified, bytes)) => {
            (Some((held_length, held_modified)), Some(bytes))
        }
        Err(gone) if gone.kind() == io::ErrorKind::NotFound => (None, None),
        Err(failure) => {
            return EditTry::Ended(refused_by_daemon(
                "Claude Code's config could not be read",
                &failure,
            ));
        }
    };
    let parsed = bytes.map(|bytes| serde_json::from_str::<Value>(&decode_inbound_json(&bytes)));
    let mut config = match parsed {
        None => Value::Object(Map::new()),
        Some(Ok(config)) if config.is_object() => config,
        Some(Ok(_)) => return config_file_invalid("Claude Code's config is not a JSON object"),
        Some(Err(failure)) => {
            return config_file_invalid(&format!(
                "Claude Code's config is not valid JSON: {failure}"
            ));
        }
    };
    let held = value_at(&config, keys);
    if observed_entry(held) != *before {
        return EditTry::Ended(McpServerWriteOutcome::Refused(
            McpServerWriteRefusal::EntryChanged,
        ));
    }
    if held == Some(&edited) {
        return EditTry::Ended(McpServerWriteOutcome::Applied {
            reload_failure: None,
        });
    }
    let (server_name, containers) = keys
        .split_last()
        .expect("an entry's place ends with its server's name");
    let Some(servers) = servers_object(&mut config, containers) else {
        return config_file_invalid(
            "a member holding the server in Claude Code's config is not a JSON object",
        );
    };
    servers.insert(server_name.clone(), edited);
    // Two-space indentation and no closing newline, as Claude Code writes its config.
    let rendered = match serde_json::to_string_pretty(&config) {
        Ok(rendered) => rendered,
        Err(failure) => {
            return EditTry::Ended(refused_by_daemon(
                "Claude Code's config could not be written",
                &failure,
            ));
        }
    };
    let Some((held_length, held_modified)) = held_stat else {
        on_rename_due();
        if is_hold_past_bound() {
            return EditTry::Ended(McpServerWriteOutcome::Refused(
                McpServerWriteRefusal::ConfigFileBusy,
            ));
        }
        return create_config_file(file, rendered.as_bytes(), new_file_mode);
    };
    let mut is_past_bound = false;
    let written = write_and_flush_while(file, rendered.as_bytes(), || {
        on_rename_due();
        if is_hold_past_bound() {
            is_past_bound = true;
            return Ok(false);
        }
        match fs::metadata(file) {
            Ok(stat) => Ok(stat.len() == held_length && stat.modified()? == held_modified),
            Err(gone) if gone.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(failure) => Err(failure),
        }
    });
    EditTry::Ended(match written {
        Ok(true) => McpServerWriteOutcome::Applied {
            reload_failure: None,
        },
        Ok(false) if is_past_bound => {
            McpServerWriteOutcome::Refused(McpServerWriteRefusal::ConfigFileBusy)
        }
        Ok(false) => return EditTry::FileChanged,
        // The file may hold the edit, or holds it with its folder not yet flushed, so it is
        // observed again.
        Err(AtomicWriteError::FlushFolder { .. } | AtomicWriteError::Interrupted { .. }) => {
            McpServerWriteOutcome::Unknown
        }
        Err(failure @ AtomicWriteError::Write { .. }) => {
            refused_by_daemon("Claude Code's config could not be written", &failure)
        }
    })
}

// Makes `file`, not there when it was read, holding `contents` with `mode`, then flushes its
// folder; a file another writer made meanwhile is left as it is.
fn create_config_file(file: &Path, contents: &[u8], mode: u32) -> EditTry {
    match create_file_atomically(file, contents, mode, LeftoverSweep::Unswept) {
        Ok(()) => {}
        Err(made) if made.failure.kind() == io::ErrorKind::AlreadyExists => {
            return EditTry::FileChanged;
        }
        Err(failure) => {
            return EditTry::Ended(refused_by_daemon(
                "Claude Code's config could not be written",
                &failure,
            ));
        }
    }
    let folder = file
        .parent()
        .expect("a path ending in a file name has the folder before it");
    EditTry::Ended(match flush_folder(folder) {
        Ok(()) => McpServerWriteOutcome::Applied {
            reload_failure: None,
        },
        // The file holds the edit with its folder not yet flushed, so it is observed again.
        Err(failure) => {
            tracing::warn!(
                error = &failure as &(dyn Error + 'static),
                "the folder of Claude Code's new config could not be flushed"
            );
            McpServerWriteOutcome::Unknown
        }
    })
}

// The object at `keys` in `config`, each missing member on the way made an empty object; `None`
// where a member on the way is something other than an object.
fn servers_object<'config>(
    config: &'config mut Value,
    keys: &[String],
) -> Option<&'config mut Map<String, Value>> {
    keys.iter()
        .try_fold(config.as_object_mut()?, |object, key| {
            object
                .entry(key.clone())
                .or_insert_with(|| Value::Object(Map::new()))
                .as_object_mut()
        })
}

// A refusal of a config the edit cannot write into, in the daemon's `words`.
fn config_file_invalid(words: &str) -> EditTry {
    EditTry::Ended(McpServerWriteOutcome::Refused(
        McpServerWriteRefusal::ConfigFileInvalid {
            words: provider_words_without_values(words),
        },
    ))
}

/// A refusal in the daemon's own words: `context`, then `failure` and its causes.
pub(super) fn refused_by_daemon(
    context: &str,
    failure: &(dyn Error + 'static),
) -> McpServerWriteOutcome {
    McpServerWriteOutcome::refused_in_words(&format!("{context}: {}", describe_error(failure)))
}

#[cfg(test)]
mod tests {
    use std::fs::{self, FileTimes};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier, OnceLock};
    use std::time::{Duration, SystemTime};

    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::mcp::server::McpServerName;
    use sidekicks_platforms::{has_file_mode, make_file_link};
    use sidekicks_std::file::atomic_write::write_file_atomically;
    use tokio::sync::Notify;
    use tokio::time::Instant;

    use super::{ClaudeConfigLock, ClaudeEditTarget, edit_entry};
    use crate::driver::mcp_server::write::{
        McpServerEntry, McpServerObservedEntry, McpServerWriteOutcome, McpServerWriteRefusal,
    };

    // One row of the guarded edit: how the file stands and what happens to it during the edit.
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum GuardRow {
        // Another writer rewrites the person's config, at its length, just before the rename.
        AnotherWriter,
        // Another writer rewrites a project's `.mcp.json` just before every rename.
        ChangingServersFile,
        // The file's entry differs from the one observed.
        ChangedEntry,
        // The person's config is a link to the file that holds it.
        LinkedConfig,
        // Another writer holds Claude Code's lock, its folder fresh.
        HeldLock,
    }

    // The file's bytes holding `entry` and one member the edit never touches, numbered `startups`.
    fn config_bytes(entry: &Value, startups: u8) -> Vec<u8> {
        serde_json::to_vec_pretty(&json!({"numStartups": startups, "mcpServers": {"docs": entry}}))
            .unwrap()
    }

    // The edit lands only on the entry it observed and the file it read, through the link to the
    // config, under Claude Code's lock, keeping the file's mode. Killed by no unchanged check, a
    // changed file answered as busy, no entry compare, a rename over the link, no lock, a mode
    // reset, and a `.mcp.json` edit tried other than five times.
    #[rstest]
    #[case::another_writer_before_the_rename(
        GuardRow::AnotherWriter,
        1,
        McpServerWriteOutcome::Refused(McpServerWriteRefusal::ConfigFileChanged)
    )]
    #[case::a_servers_file_that_keeps_changing(
        GuardRow::ChangingServersFile,
        5,
        McpServerWriteOutcome::Refused(McpServerWriteRefusal::ConfigFileChanged)
    )]
    #[case::an_entry_changed_since_observed(
        GuardRow::ChangedEntry,
        0,
        McpServerWriteOutcome::Refused(McpServerWriteRefusal::EntryChanged)
    )]
    #[case::a_linked_config(
        GuardRow::LinkedConfig,
        1,
        McpServerWriteOutcome::Applied { reload_failure: None }
    )]
    #[case::a_held_lock(
        GuardRow::HeldLock,
        0,
        McpServerWriteOutcome::Refused(McpServerWriteRefusal::ConfigFileBusy)
    )]
    #[tokio::test(start_paused = true)]
    async fn the_edit_lands_only_on_the_entry_and_file_it_read(
        #[case] row: GuardRow,
        #[case] renames_due_expected: usize,
        #[case] expected: McpServerWriteOutcome,
    ) {
        let is_servers_file = row == GuardRow::ChangingServersFile;
        let is_file_rewritten =
            matches!(row, GuardRow::AnotherWriter | GuardRow::ChangingServersFile);
        let home = tempfile::tempdir().unwrap();
        let name = if is_servers_file {
            ".mcp.json"
        } else {
            ".claude.json"
        };
        let config = home.path().join(name);
        let file = if row == GuardRow::LinkedConfig {
            let file = home.path().join("dotfiles").join("claude.json");
            fs::create_dir(home.path().join("dotfiles")).unwrap();
            make_file_link(&file, &config).unwrap();
            file
        } else {
            config.clone()
        };
        let observed = json!({"command": "npx"});
        let held = if row == GuardRow::ChangedEntry {
            json!({"command": "other"})
        } else {
            observed.clone()
        };
        let read_bytes = config_bytes(&held, 3);
        write_file_atomically(&file, read_bytes.clone(), 0o600)
            .await
            .unwrap();
        if row == GuardRow::HeldLock {
            fs::create_dir(home.path().join(format!("{name}.lock"))).unwrap();
        }
        // Another writer's bytes, as long as the ones read, so only the time tells them apart.
        let other_bytes = config_bytes(&held, 4);
        let renames_due = Arc::new(AtomicUsize::new(0));
        let on_rename_due = {
            let (file, other_bytes) = (file.clone(), other_bytes.clone());
            let renames_due = Arc::clone(&renames_due);
            move || {
                let due = renames_due.fetch_add(1, Ordering::SeqCst);
                if is_file_rewritten {
                    fs::write(&file, &other_bytes).unwrap();
                    let moved = SystemTime::UNIX_EPOCH
                        + Duration::from_secs(1 + u64::try_from(due).unwrap());
                    fs::set_times(&file, FileTimes::new().set_modified(moved)).unwrap();
                }
            }
        };
        let target = if is_servers_file {
            ClaudeEditTarget::ProjectServersFile {
                path: config.clone(),
            }
        } else {
            ClaudeEditTarget::PersonConfig {
                path: config.clone(),
                project_key: None,
            }
        };
        let written = json!({"command": "npx", "args": ["--verbose"]});

        let outcome = edit_entry(
            target,
            &McpServerName::new("docs".to_owned()).unwrap(),
            &McpServerEntry::from_json(written.clone()),
            &McpServerObservedEntry::Present(McpServerEntry::from_json(observed)),
            Instant::now() + Duration::from_millis(300),
            on_rename_due,
        )
        .await;

        assert_eq!(outcome, expected);
        assert_eq!(renames_due.load(Ordering::SeqCst), renames_due_expected);
        let after = fs::read(&file).unwrap();
        match expected {
            McpServerWriteOutcome::Applied { .. } => {
                let after: Value = serde_json::from_slice(&after).unwrap();
                assert_eq!(
                    after,
                    json!({"numStartups": 3, "mcpServers": {"docs": written}})
                );
                assert!(has_file_mode(&file, 0o600).unwrap());
                assert!(fs::symlink_metadata(&config).unwrap().is_symlink());
            }
            McpServerWriteOutcome::Refused(_) | McpServerWriteOutcome::Unknown => {
                let kept = if is_file_rewritten {
                    other_bytes
                } else {
                    read_bytes
                };
                assert_eq!(after, kept);
            }
        }
    }

    // One row of an add: how the file stands when the add reads it, and during the add.
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum AddRow {
        // No person's config is there.
        MissingConfig,
        // No project's `.mcp.json` is there.
        MissingServersFile,
        // No person's config is there, and another writer makes one just before the add would.
        ConfigMadeMeanwhile,
        // The person's config already holds the server's entry.
        EntryAddedMeanwhile,
    }

    // An add lands only while the entry is still absent: a file not there yet is made holding the
    // entry alone, with the mode Claude Code makes it with, and a file or an entry another writer
    // made first is left as it is. Killed by a missing file refused, a new file made with another
    // mode, a file made meanwhile written over, and an entry already there written over.
    #[rstest]
    #[case::a_missing_config(
        AddRow::MissingConfig,
        McpServerWriteOutcome::Applied { reload_failure: None }
    )]
    #[case::a_missing_servers_file(
        AddRow::MissingServersFile,
        McpServerWriteOutcome::Applied { reload_failure: None }
    )]
    #[case::a_config_made_meanwhile(
        AddRow::ConfigMadeMeanwhile,
        McpServerWriteOutcome::Refused(McpServerWriteRefusal::ConfigFileChanged)
    )]
    #[case::an_entry_added_meanwhile(
        AddRow::EntryAddedMeanwhile,
        McpServerWriteOutcome::Refused(McpServerWriteRefusal::EntryChanged)
    )]
    #[tokio::test]
    async fn an_add_lands_only_while_the_entry_is_absent(
        #[case] row: AddRow,
        #[case] expected: McpServerWriteOutcome,
    ) {
        let home = tempfile::tempdir().unwrap();
        let is_servers_file = row == AddRow::MissingServersFile;
        let file = home.path().join(if is_servers_file {
            ".mcp.json"
        } else {
            ".claude.json"
        });
        let other_bytes = config_bytes(&json!({"command": "other"}), 4);
        if row == AddRow::EntryAddedMeanwhile {
            write_file_atomically(&file, other_bytes.clone(), 0o600)
                .await
                .unwrap();
        }
        let on_rename_due = {
            let (file, other_bytes) = (file.clone(), other_bytes.clone());
            move || {
                if row == AddRow::ConfigMadeMeanwhile {
                    fs::write(&file, &other_bytes).unwrap();
                }
            }
        };
        let target = if is_servers_file {
            ClaudeEditTarget::ProjectServersFile { path: file.clone() }
        } else {
            ClaudeEditTarget::PersonConfig {
                path: file.clone(),
                project_key: None,
            }
        };
        let written = json!({"command": "npx", "args": ["docs"]});

        let outcome = edit_entry(
            target,
            &McpServerName::new("docs".to_owned()).unwrap(),
            &McpServerEntry::from_json(written.clone()),
            &McpServerObservedEntry::Absent,
            Instant::now() + Duration::from_secs(10),
            on_rename_due,
        )
        .await;

        assert_eq!(outcome, expected);
        let after = fs::read(&file).unwrap();
        if matches!(expected, McpServerWriteOutcome::Applied { .. }) {
            assert_eq!(
                serde_json::from_slice::<Value>(&after).unwrap(),
                json!({"mcpServers": {"docs": written}})
            );
            let mode = if is_servers_file { 0o644 } else { 0o600 };
            assert!(has_file_mode(&file, mode).unwrap());
        } else {
            assert_eq!(after, other_bytes);
        }
    }

    // A caller dropped while its edit is under way leaves Claude Code's lock in place through the
    // rename, which still lands, and the lock goes once the try ends. The drop runs off the
    // runtime, where a lock the caller held is removed before the drop returns. Killed by the lock
    // released by the caller, a release ahead of the rename, and a lock never released.
    #[tokio::test]
    async fn a_dropped_callers_rename_lands_under_the_lock() {
        let home = tempfile::tempdir().unwrap();
        let config = home.path().join(".claude.json");
        let folder = home.path().join(".claude.json.lock");
        let observed = json!({"command": "npx"});
        write_file_atomically(&config, config_bytes(&observed, 3), 0o600)
            .await
            .unwrap();
        let rename_due = Arc::new(Notify::new());
        let rename_hold = Arc::new(Barrier::new(2));
        let is_locked_at_rename = Arc::new(OnceLock::new());
        let on_rename_due = {
            let (rename_due, rename_hold) = (Arc::clone(&rename_due), Arc::clone(&rename_hold));
            let is_locked_at_rename = Arc::clone(&is_locked_at_rename);
            move || {
                rename_due.notify_one();
                rename_hold.wait();
                is_locked_at_rename.set(folder.is_dir()).unwrap();
            }
        };
        let written = json!({"command": "npx", "args": ["--verbose"]});
        let mut edit = Box::pin({
            let (config, written) = (config.clone(), written.clone());
            async move {
                let server_name = McpServerName::new("docs".to_owned()).unwrap();
                let entry = McpServerEntry::from_json(written);
                let before = McpServerObservedEntry::Present(McpServerEntry::from_json(observed));
                edit_entry(
                    ClaudeEditTarget::PersonConfig {
                        path: config,
                        project_key: None,
                    },
                    &server_name,
                    &entry,
                    &before,
                    Instant::now() + Duration::from_secs(5),
                    on_rename_due,
                )
                .await
            }
        });

        tokio::select! {
            outcome = &mut edit => panic!("the edit ended before its rename was due: {outcome:?}"),
            () = rename_due.notified() => {}
        }
        let dropped = std::thread::spawn(move || drop(edit)).join();
        let rename_hold = Arc::clone(&rename_hold);
        tokio::task::spawn_blocking(move || rename_hold.wait())
            .await
            .unwrap();
        dropped.unwrap();
        let lock = ClaudeConfigLock::take(&config, Instant::now() + Duration::from_secs(5))
            .await
            .unwrap();

        assert_eq!(is_locked_at_rename.get(), Some(&true));
        let after: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
        assert_eq!(
            after,
            json!({"numStartups": 3, "mcpServers": {"docs": written}}),
            "the rename lands only while the hook's pause stays under the 2 s LOCK_HOLD_MAX"
        );
        lock.release().unwrap();
    }
}
