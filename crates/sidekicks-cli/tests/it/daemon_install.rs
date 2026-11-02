//! `sidekicks daemon install` and `uninstall` against the system's real service manager: the login
//! agent under a home of the test's own, so the registration and the data folder are the test's;
//! the system service that runs while the person is logged out under this account's own home,
//! since that service runs the daemon there and its secrets sit in this account's login keychain.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde::Deserialize;
use sidekicks_contracts::app_identity::DAEMON_LAUNCHD_LABEL;
use sidekicks_contracts::daemon::data::DAEMON_DATA_FOLDER_NAME;
use sidekicks_platforms::has_file_mode;

use crate::helpers::{PrivateFolders, built_daemon_program, path_text, text};

/// The line `daemon install --while-signed-out` prints before it asks for the password.
const FILES_LINE: &str = "With this on, sign-ins and secrets are kept in files readable by this \
                          account alone, because a service that runs while you are logged out \
                          cannot reach the login keychain.\n";

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

/// The secrets file `daemon status --json` names, present only while the service keeps its
/// secrets in a file.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusSecretsFile {
    secrets_file: Option<SecretsFile>,
}

#[derive(Deserialize)]
struct SecretsFile {
    path: PathBuf,
}

/// Runs the built `sidekicks` with `arguments` under this account's own home and folders.
fn run_sidekicks_as_this_account(arguments: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_sidekicks"))
        .args(arguments)
        .output()
        .expect("the program runs")
}

/// The secrets file the running service names, or `None` when it keeps its secrets in the login
/// keychain or does not answer.
fn read_secrets_file() -> Option<PathBuf> {
    let status = run_sidekicks_as_this_account(&["daemon", "status", "--json"]);
    serde_json::from_slice::<StatusSecretsFile>(&status.stdout)
        .ok()
        .and_then(|status| status.secrets_file)
        .map(|secrets_file| secrets_file.path)
}

/// Installs the system service with the built daemon program as its program.
fn install_while_signed_out() -> Output {
    let daemon = built_daemon_program();
    run_sidekicks_as_this_account(&[
        "daemon",
        "install",
        "--while-signed-out",
        "--daemon-path",
        path_text(&daemon),
    ])
}

// Run with this account's login agent installed and running; the person cancels the password
// prompt. Fails when the files line is printed after the ask,
// since a canceled ask then prints nothing on stdout, and when a step is not put back, since the
// login agent's service then keeps its secrets in a file.
#[test]
#[ignore = "installs a system service behind an administrator's password: run by hand at a Mac"]
fn a_canceled_password_prompt_puts_everything_back_and_exits_77() {
    assert_eq!(
        read_secrets_file(),
        None,
        "the secrets are in a file before the install"
    );

    let canceled = install_while_signed_out();

    assert_eq!(
        canceled.status.code(),
        Some(77),
        "{}",
        text(&canceled.stderr)
    );
    assert_eq!(text(&canceled.stdout), FILES_LINE);
    assert_eq!(
        text(&canceled.stderr),
        "error: This Mac cannot keep the background service running while you are logged out: \
         the administrator password was not given.\n"
    );
    assert_eq!(read_secrets_file(), None, "the secrets stayed in a file");
}

// The person gives the password, and removes the service after with `sidekicks daemon uninstall`.
// Fails when the secrets do not move into a file only this account can read, or the system service
// never answers.
#[test]
#[ignore = "installs a system service behind an administrator's password: run by hand at a Mac"]
fn a_given_password_installs_the_system_service_with_the_secrets_in_a_private_file() {
    let installed = install_while_signed_out();

    assert_eq!(
        installed.status.code(),
        Some(0),
        "{}",
        text(&installed.stderr)
    );
    assert_eq!(
        text(&installed.stdout),
        format!(
            "{FILES_LINE}Installed the background service for this Mac. It runs while you are \
             logged out.\n"
        )
    );
    let secrets_file = read_secrets_file().expect("the system service keeps its secrets in a file");
    assert!(
        has_file_mode(&secrets_file, 0o600).expect("the secrets file is there"),
        "{} is not readable by this account alone",
        secrets_file.display()
    );
}
