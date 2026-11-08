//! The current user's id, and its entry in the user database (its name and login shell), on macOS
//! and Linux.

use std::io::{self, ErrorKind};
use std::path::PathBuf;

use nix::unistd::{User, getuid};

/// The current user's real id, the one a provider names its per-user socket folder with; `None`
/// on native Windows, which has none.
pub fn current_user_id() -> Option<u32> {
    Some(getuid().as_raw())
}

/// The current user's login name from the user database, the name a provider files its keychain
/// item under when its environment names none; `None` where the database has no entry for the id
/// or cannot be read, which such a provider answers with a fixed name.
pub fn current_user_name() -> Option<String> {
    read_current_user().ok().map(|(name, _)| name)
}

/// The current user's entry in the user database, read at each call: its login name and the login
/// shell it names, `None` when it names none. Fails with the system's error from the read, and with
/// `NotFound` when the account has no entry.
pub(crate) fn read_current_user() -> io::Result<(String, Option<PathBuf>)> {
    let user = User::from_uid(getuid())?.ok_or_else(|| {
        io::Error::new(
            ErrorKind::NotFound,
            "the account has no entry in the user database",
        )
    })?;
    let shell = (!user.shell.as_os_str().is_empty()).then_some(user.shell);
    Ok((user.name, shell))
}
