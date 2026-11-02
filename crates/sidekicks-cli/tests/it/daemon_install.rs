//! `sidekicks daemon install` and `uninstall` against the system's real service manager: both
//! refused under a home of the test's own, which is not the account's; the login agent's install
//! and removal under this account's own home, since the agent's service runs there; and the system
//! service that runs while the person is logged out under this account's own home too, since that
//! service runs the daemon there and its secrets sit in this account's login keychain.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde::Deserialize;
use sidekicks_contracts::app_identity::DAEMON_LAUNCHD_LABEL;
use sidekicks_contracts::daemon::data::DAEMON_DATA_FOLDER_NAME;
use sidekicks_platforms::{has_file_mode, service_registration};

use crate::helpers::{PrivateFolders, built_daemon_program, path_text, text};

/// The line `daemon install --while-signed-out` prints before it asks for the password.
const FILES_LINE: &str = "With this on, sign-ins and secrets are kept in files readable by this \
                          account alone, because a service that runs while you are logged out \
                          cannot reach the login keychain.\n";

/// The line an install or uninstall under a home that is not the account's is refused with.
const NOT_ACCOUNT_HOME_LINE: &str = "error: HOME is not set to your home folder, so the background \
                                     service was left as it is. Set HOME to your home folder and \
                                     run the command again.\n";

/// Boots the login agent out of this account's login session and removes its list through the
/// system's registration itself when it drops, not through the command line, so a failed assert or
/// a broken uninstall leaves no login agent behind.
struct AgentBootOut;

impl Drop for AgentBootOut {
    #[expect(
        clippy::print_stderr,
        reason = "a drop cannot fail the test, so a failed removal is said on its output"
    )]
    fn drop(&mut self) {
        let registration = service_registration().expect("macOS registers the service");
        if let Err(error) = registration.uninstall() {
            eprintln!("the test's login agent could not be removed: {error}");
        }
    }
}

/// The login agent's list in `home`.
fn agent_list(home: &Path) -> PathBuf {
    home.join("Library/LaunchAgents")
        .join(format!("{DAEMON_LAUNCHD_LABEL}.plist"))
}

// Fails when an install or uninstall under a home that is not the account's goes on, since the
// install then loads an agent into the account's login session whose service serves another home,
// and the uninstall reads that agent as not installed and leaves it loaded.
#[test]
#[cfg_attr(
    not(target_os = "macos"),
    ignore = "only macOS offers the install and uninstall"
)]
fn an_install_or_uninstall_under_another_home_is_refused_with_78_and_changes_nothing() {
    let folders = PrivateFolders::new();

    for command in ["install", "uninstall"] {
        let refused = folders.run_sidekicks(&["daemon", command]);

        assert_eq!(refused.status.code(), Some(78), "{}", text(&refused.stderr));
        assert_eq!(text(&refused.stdout), "");
        assert_eq!(text(&refused.stderr), NOT_ACCOUNT_HOME_LINE);
    }
    assert!(
        !agent_list(&folders.path().join("h")).exists(),
        "the install wrote a registration"
    );
}

// Fails when the uninstall leaves the registration in place, or removes the data folder with it.
#[test]
#[ignore = "it loads a real login agent into this account's login session under this account's \
            own home, running the built daemon on this account's data folder, which a person's \
            own install or the app would hold"]
fn an_uninstall_removes_what_the_install_wrote_and_keeps_the_data_folder() {
    let home = std::env::home_dir().expect("this account has a home");
    let daemon = built_daemon_program();
    let _boot_out = AgentBootOut;

    let installed =
        run_sidekicks_as_this_account(&["daemon", "install", "--daemon-path", path_text(&daemon)]);
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

    let removed = run_sidekicks_as_this_account(&["daemon", "uninstall"]);
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
    let status = run_sidekicks_as_this_account(&["daemon", "status"]);
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

/// The system service's list, which only its install writes.
fn system_service_list() -> PathBuf {
    Path::new("/Library/LaunchDaemons").join(format!("{DAEMON_LAUNCHD_LABEL}.plist"))
}

// Run after the given-password leg, with the login keychain locked by hand first. Fails when the
// keychain's check is dropped or comes after the removal, since the service is then removed while
// the secrets cannot go back.
#[test]
#[ignore = "acts on this account's system service with the login keychain locked by hand first: \
            run by hand at a Mac"]
fn a_locked_keychain_keeps_the_system_service_and_its_files() {
    let secrets_file = read_secrets_file().expect("the system service keeps its secrets in a file");

    let kept = run_sidekicks_as_this_account(&["daemon", "uninstall"]);

    assert_eq!(kept.status.code(), Some(69), "{}", text(&kept.stderr));
    assert_eq!(text(&kept.stdout), "");
    assert_eq!(
        text(&kept.stderr),
        "error: The sign-ins and secrets cannot go back into the login keychain while it is \
         locked. Log in at this Mac, then run sidekicks daemon uninstall again.\n"
    );
    assert!(
        system_service_list().is_file(),
        "the system service was removed"
    );
    assert!(secrets_file.is_file(), "the secrets file was removed");
}

// Run after the leg above, with the login keychain unlocked again; the person gives the password.
// Fails when the secrets do not move back, since their file is then left and the login agent's
// service names it, and when the login agent is not put back and answering.
#[test]
#[ignore = "removes a system service behind an administrator's password: run by hand at a Mac"]
fn an_uninstall_moves_the_secrets_back_into_the_login_keychain() {
    let secrets_file = read_secrets_file().expect("the system service keeps its secrets in a file");

    let removed = run_sidekicks_as_this_account(&["daemon", "uninstall"]);

    assert_eq!(removed.status.code(), Some(0), "{}", text(&removed.stderr));
    assert_eq!(
        text(&removed.stdout),
        "The background service no longer runs while you are logged out. It starts at login and \
         is running now.\n"
    );
    assert!(
        !system_service_list().exists(),
        "the system service's list is still there"
    );
    assert!(
        !secrets_file.exists(),
        "{} is still there",
        secrets_file.display()
    );
    assert_eq!(read_secrets_file(), None, "the secrets stayed in a file");
}
