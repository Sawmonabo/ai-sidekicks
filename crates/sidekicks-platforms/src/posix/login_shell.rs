//! The account's login shell on macOS and Linux, read from the user database.

use std::io::{self, ErrorKind};
use std::path::PathBuf;

use nix::unistd::{User, getuid};

/// The login shell the user database names for the account this process runs as, read at each
/// call; `None` when the entry names none. Fails with the system's error from the read, and with
/// `NotFound` when the account has no entry.
pub fn login_shell() -> io::Result<Option<PathBuf>> {
    let user = User::from_uid(getuid())?.ok_or_else(|| {
        io::Error::new(
            ErrorKind::NotFound,
            "the account has no entry in the user database",
        )
    })?;
    Ok((!user.shell.as_os_str().is_empty()).then_some(user.shell))
}
