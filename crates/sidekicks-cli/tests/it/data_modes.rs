//! `sidekicks data erase` and `data restore` against the built daemon program's offline modes,
//! each run under a home, temporary folder and runtime folder of the test's own. No erase acts,
//! since a successful one would also empty this account's keychain items; a restore touches no
//! keychain, so one leg lets it act.

use std::fs::{self, File};
use std::path::PathBuf;

use serde_json::json;
use sidekicks_contracts::daemon::backup::{BACKUP_DATABASE_FILE_NAME, BACKUP_MANIFEST_FILE_NAME};
use sidekicks_contracts::daemon::data::{DAEMON_DATA_FOLDER_NAME, DAEMON_LOCK_FILE_NAME};

use crate::helpers::{DaemonEnding, PrivateFolders, built_daemon_program, path_text, text};

/// Makes the data folder under the folders' home with a file in it, and answers the folder and
/// the file.
fn make_data_folder_with_marker(folders: &PrivateFolders) -> (PathBuf, PathBuf) {
    let data_folder = folders.path().join("h").join(DAEMON_DATA_FOLDER_NAME);
    fs::create_dir(&data_folder).expect("the data folder is made");
    let marker = data_folder.join("kept");
    fs::write(&marker, "kept").expect("the marker is written");
    (data_folder, marker)
}

// Fails when the restore mode reads the backup before it takes the data folder's lock, since the
// missing backup then exits 66; when a held folder's refusal maps to any code but 78; and when a
// mode changes a folder it does not hold.
#[test]
fn a_held_data_folder_refuses_the_erase_and_the_restore_with_78_and_keeps_its_files() {
    built_daemon_program();
    let folders = PrivateFolders::new();
    let (data_folder, marker) = make_data_folder_with_marker(&folders);
    // A service still starting: the lock held, no socket bound, so the command's handshake finds
    // nothing and only the mode's own lock refuses it.
    let lock = File::create(data_folder.join(DAEMON_LOCK_FILE_NAME)).expect("the lock file opens");
    lock.try_lock().expect("the lock is free");
    let missing_backup = folders.path().join("no-backup");

    for arguments in [
        vec!["data", "restore", "--yes", path_text(&missing_backup)],
        vec!["data", "erase", "--yes"],
    ] {
        let run = folders.run_sidekicks(&arguments);
        assert_eq!(
            run.status.code(),
            Some(78),
            "{arguments:?}: {}",
            text(&run.stderr)
        );
        assert_eq!(
            text(&run.stderr),
            "error: The background service is already running.\n",
            "{arguments:?}"
        );
        assert_eq!(text(&run.stdout), "", "{arguments:?}");
        assert!(
            marker.is_file(),
            "{arguments:?} changed the held data folder"
        );
    }
}

// Fails when the restore exits 0 without putting the backup's store back, since the store the test
// removed is then still missing; and when its success maps to any code but 0.
#[test]
fn a_restore_puts_the_backup_s_store_back_and_exits_0() {
    let folders = PrivateFolders::new();
    let daemon = built_daemon_program();
    let _ending = DaemonEnding::new(&folders);
    // The built daemon writes a store of this build's schema, which is all a restore accepts.
    let started = folders.run_sidekicks(&[
        "daemon",
        "start",
        "--daemon-path",
        path_text(&daemon),
        "--timeout",
        "60000",
    ]);
    assert_eq!(started.status.code(), Some(0), "{}", text(&started.stderr));
    let stopped = folders.run_sidekicks(&["daemon", "stop", "--yes"]);
    assert_eq!(stopped.status.code(), Some(0), "{}", text(&stopped.stderr));

    let data_folder = folders.path().join("h").join(DAEMON_DATA_FOLDER_NAME);
    let store = data_folder.join("daemon.db");
    let backup = folders.path().join("backups").join("backup");
    fs::create_dir_all(&backup).expect("the backup's folder is made");
    fs::copy(&store, backup.join(BACKUP_DATABASE_FILE_NAME)).expect("the store is copied");
    let manifest = json!({
        "backupId": "backup",
        "takenAt": "2026-10-20T03:00:00.000Z",
        "appVersion": "0.1.0",
        "serviceVersion": "0.1.0",
        "totalBytes": 4096,
        "computerName": "Studio",
    });
    fs::write(
        backup.join(BACKUP_MANIFEST_FILE_NAME),
        serde_json::to_vec(&manifest).expect("the manifest writes"),
    )
    .expect("the manifest is written");
    fs::remove_file(&store).expect("the store is removed");

    let restored = folders.run_sidekicks(&["data", "restore", "--yes", path_text(&backup)]);

    assert_eq!(
        restored.status.code(),
        Some(0),
        "{}",
        text(&restored.stderr)
    );
    assert_eq!(
        text(&restored.stdout),
        "Restored the backup. Start the background service with sidekicks daemon start.\n"
    );
    assert!(store.is_file(), "the restore did not put the store back");
}

// Fails when the erase asks without a terminal, since the question then reads the empty input as
// a no and exits 0.
#[test]
fn an_erase_with_no_terminal_and_no_yes_exits_64_and_keeps_the_data_folder() {
    built_daemon_program();
    let folders = PrivateFolders::new();
    let (_, marker) = make_data_folder_with_marker(&folders);

    let run = folders.run_sidekicks(&["data", "erase"]);

    assert_eq!(run.status.code(), Some(64), "{}", text(&run.stderr));
    assert_eq!(
        text(&run.stderr),
        "error: no terminal is here to confirm the command: run it again with --yes\n"
    );
    assert!(marker.is_file(), "the erase changed the data folder");
}
