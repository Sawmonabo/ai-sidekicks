//! Opening an address, such as an app link, in the application the system has registered for its
//! scheme, whether a browser opened from this process reaches the person it is for, and the opener
//! that opens nothing; each platform's module makes the system's own call and holds the system's
//! own reach rule, and this one holds the answer all of them give when no application is
//! registered and the reach rule all of them share.

use std::io::{self, ErrorKind};

#[cfg(target_os = "linux")]
use crate::linux::address_opening::can_reach_display;
#[cfg(target_os = "macos")]
use crate::macos::address_opening::can_reach_display;
#[cfg(target_os = "windows")]
use crate::windows::address_opening::can_reach_display;

/// A program the `BROWSER` variable can name that opens nothing and does not fail, so a program
/// that opens its addresses through that variable opens no browser on this machine.
#[cfg(unix)]
pub const NO_BROWSER_OPENER: &str = "/usr/bin/true";

/// A program the `BROWSER` variable can name that opens nothing, so a program that opens its
/// addresses through that variable opens no browser on this machine: Windows ships no program
/// that does nothing, so this is a name no Windows system folder holds, whose start fails and
/// opens nothing.
#[cfg(windows)]
pub const NO_BROWSER_OPENER: &str = "true";

/// The variables an SSH login sets, any one of which says the person sits at another machine.
const SSH_LOGIN_VARIABLES: [&str; 3] = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"];

/// The error every platform answers when the system reports no application registered for an
/// address's scheme: `NotFound`, the one kind a caller reads as "no handler".
pub(crate) fn no_handler_error() -> io::Error {
    io::Error::new(
        ErrorKind::NotFound,
        "no application is registered to open this address",
    )
}

/// Whether a browser opened from this process, in `environment`, shows where its person is. No in
/// an SSH login (`SSH_CONNECTION`, `SSH_CLIENT` or `SSH_TTY` set) on every system; on macOS, when
/// the process's security session has no graphics access or was made over the network; on Linux,
/// when none of `DISPLAY`, `WAYLAND_DISPLAY` and `MIR_SOCKET` is set and not empty, or, inside a
/// WSL distribution, whatever the display, when its interop with Windows is off; on Windows, when
/// the process's window station has no visible display, as a service's has none. It reads
/// `environment`, never the process's own, and may read a file or make a system call, so it runs
/// off an async runtime's threads.
pub fn can_open_browser(environment: &[(String, String)]) -> bool {
    !is_ssh_login(environment) && can_reach_display(environment)
}

// Whether `environment` is an SSH login's, by any of its variables set.
fn is_ssh_login(environment: &[(String, String)]) -> bool {
    environment
        .iter()
        .any(|(name, _)| SSH_LOGIN_VARIABLES.contains(&name.as_str()))
}

#[cfg(test)]
mod reach_tests {
    use super::can_open_browser;

    // Killed by any one of the three variables dropped; the display beside it, and the SSH rule
    // read first, keep the system's own rule from answering.
    #[test]
    fn no_browser_opens_in_an_ssh_login() {
        for variable in ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"] {
            let environment = [
                ("DISPLAY".to_owned(), ":0".to_owned()),
                (
                    variable.to_owned(),
                    "192.0.2.1 50000 192.0.2.2 22".to_owned(),
                ),
            ];
            assert!(
                !can_open_browser(&environment),
                "{variable} opens a browser"
            );
        }
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use std::io::ErrorKind;

    use crate::open_address;

    #[test]
    fn an_address_no_application_claims_answers_not_found() {
        let error = open_address("sidekicks-unclaimed-scheme-test://nothing")
            .expect_err("no application claims the made-up scheme");
        assert_eq!(error.kind(), ErrorKind::NotFound, "{error}");
    }
}
