//! The providers' base environment in the service a test starts: the service's own, so no run of
//! the program on a temporary home runs the account's login shell.

use std::fs;

use crate::helpers::{short_home, start_ready_service};

// The startup file each kind of login shell reads from its home: zsh's, bash's, a POSIX shell's
// and fish's.
const STARTUP_FILES: [&str; 4] = [
    ".zshenv",
    ".bash_profile",
    ".profile",
    ".config/fish/config.fish",
];

// The service starts ready with no startup file in its home run. Killed by the isolated start
// capturing the login shell's environment: the account's shell then reads its startup file in the
// home, which writes the mark, before the start goes on.
#[tokio::test]
async fn the_service_a_test_starts_runs_no_login_shell() {
    let home = short_home();
    let mark = home.path().join("login-shell-ran");
    for startup_file in STARTUP_FILES {
        let path = home.path().join(startup_file);
        fs::create_dir_all(path.parent().expect("a startup file sits in a folder"))
            .expect("the startup file's folder is made");
        fs::write(&path, format!("touch '{}'\n", mark.display()))
            .expect("the startup file is written");
    }

    let (_service, _standard_error) = start_ready_service(home.path()).await;

    assert!(
        !mark.exists(),
        "a login shell ran a startup file in the service's home"
    );
}
