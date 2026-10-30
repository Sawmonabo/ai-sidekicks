//! `sidekicks daemon install` and `uninstall` against the system's real service manager, under a
//! home of the test's own, so the registration and the data folder are the test's.

use std::path::{Path, PathBuf};

use sidekicks_contracts::app_identity::DAEMON_LAUNCHD_LABEL;
use sidekicks_contracts::daemon::data::DAEMON_DATA_FOLDER_NAME;

use crate::helpers::{PrivateFolders, built_daemon_program, path_text, text};

/// Removes the registration these folders' install wrote when it drops, so a failed assert leaves
/// no login agent behind.
struct RegistrationRemoval<'a> {
    folders: &'a PrivateFolders,
}

impl Drop for RegistrationRemoval<'_> {
    fn drop(&mut self) {
        self.folders.run_sidekicks(&["daemon", "uninstall"]);
    }
}

/// The registration the install writes under the private home.
fn agent_list(home: &Path) -> PathBuf {
    home.join("Library/LaunchAgents")
        .join(format!("{DAEMON_LAUNCHD_LABEL}.plist"))
}

// Fails when the uninstall leaves the registration in place, or removes the data folder with it.
#[test]
#[ignore = "it loads a real login agent into this account's login session, under the service's \
            own label, which a person's own install or the app would hold"]
fn an_uninstall_removes_what_the_install_wrote_and_keeps_the_data_folder() {
    let folders = PrivateFolders::new();
    let home = folders.path().join("h");
    // The service manager starts the program with the account's own home; this one keeps the
    // daemon on the test's.
    let daemon = folders.write_script(
        "daemon-in-private-home",
        &format!(
            "HOME='{}' exec '{}'",
            path_text(&home),
            path_text(&built_daemon_program())
        ),
    );
    let _removal = RegistrationRemoval { folders: &folders };

    let installed =
        folders.run_sidekicks(&["daemon", "install", "--daemon-path", path_text(&daemon)]);
    assert_eq!(
        installed.status.code(),
        Some(0),
        "{}",
        text(&installed.stderr)
    );
    assert_eq!(
        text(&installed.stdout),
        "Installed the background service. It starts at login and is running now.\n"
    );
    assert!(
        agent_list(&home).is_file(),
        "the install wrote no registration"
    );
    let data_folder = home.join(DAEMON_DATA_FOLDER_NAME);
    assert!(
        data_folder.is_dir(),
        "the started service made no data folder"
    );

    let removed = folders.run_sidekicks(&["daemon", "uninstall"]);
    assert_eq!(removed.status.code(), Some(0), "{}", text(&removed.stderr));
    assert_eq!(
        text(&removed.stdout),
        "Removed the background service. Your data is kept.\n"
    );
    assert!(
        !agent_list(&home).exists(),
        "the registration is still there"
    );
    assert!(
        data_folder.is_dir(),
        "the uninstall removed the data folder"
    );
    let status = folders.run_sidekicks(&["daemon", "status"]);
    assert_eq!(status.status.code(), Some(69), "{}", text(&status.stdout));
}
