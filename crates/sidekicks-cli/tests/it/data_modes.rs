//! `sidekicks data erase` and `data restore` against the built daemon program's offline modes,
//! each run under a home, temporary folder and runtime folder of the test's own. No leg lets a
//! mode act: a successful erase would also empty this account's keychain items.

use std::fs::{self, File};
use std::path::PathBuf;

use sidekicks_contracts::daemon::data::{DAEMON_DATA_FOLDER_NAME, DAEMON_LOCK_FILE_NAME};

use crate::helpers::{PrivateFolders, built_daemon_program, path_text, text};

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
// missing backup then exits 70; when a held folder's refusal maps to any code but 78; and when a
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
