//! The account's login shell and name on macOS and Linux, read from the user database; how a shell
//! is started as a login shell; and on macOS the account's own temporary folder a login session
//! gets.

use std::ffi::OsString;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

use nix::unistd::{User, getuid};

use crate::session_child::SessionCommand;

/// The login shell the user database names for the account this process runs as, read at each
/// call; `None` when the entry names none. Fails with the system's error from the read, and with
/// `NotFound` when the account has no entry.
pub fn login_shell() -> io::Result<Option<PathBuf>> {
    Ok(read_account()?.1)
}

/// Starts `command`'s program `shell` as a login shell the way `login` does: its name, the first
/// word it reads of its own command line, is the shell's file name after a `-`. A shell that takes
/// no login switch beside others, as csh and tcsh, reads a login only this way.
pub fn name_as_login_shell(command: &mut SessionCommand, shell: &Path) {
    let mut name = OsString::from("-");
    name.push(shell.file_name().unwrap_or(shell.as_os_str()));
    command.argument_zero = name;
}

/// The account this process runs as: its name and the login shell its entry names, `None` when it
/// names none. Fails as [`login_shell`] fails.
pub(crate) fn read_account() -> io::Result<(String, Option<PathBuf>)> {
    let user = User::from_uid(getuid())?.ok_or_else(|| {
        io::Error::new(
            ErrorKind::NotFound,
            "the account has no entry in the user database",
        )
    })?;
    let shell = (!user.shell.as_os_str().is_empty()).then_some(user.shell);
    Ok((user.name, shell))
}

/// The account's own temporary folder, the `TMPDIR` a login session gets: on macOS the folder the
/// system keeps per account (`_CS_DARWIN_USER_TEMP_DIR`), as the system writes it; `None` on Linux,
/// whose login sets none. Fails with the system's error.
#[cfg_attr(
    target_os = "linux",
    expect(
        clippy::unnecessary_wraps,
        reason = "the macOS read of the folder can fail"
    )
)]
pub(crate) fn user_temporary_folder() -> io::Result<Option<String>> {
    #[cfg(target_os = "macos")]
    return read_configuration_text(libc::_CS_DARWIN_USER_TEMP_DIR).map(Some);
    #[cfg(target_os = "linux")]
    Ok(None)
}

// A configuration text `confstr` answers for `name`, read into a buffer of the length it asks for.
#[cfg(target_os = "macos")]
fn read_configuration_text(name: libc::c_int) -> io::Result<String> {
    // SAFETY: a null buffer of length 0 asks only for the length the text needs, NUL included.
    let length = unsafe { libc::confstr(name, std::ptr::null_mut(), 0) };
    if length == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut buffer = vec![0_u8; length];
    // SAFETY: the buffer is live and writable for `length` bytes, which the call fills.
    let written = unsafe { libc::confstr(name, buffer.as_mut_ptr().cast(), length) };
    if written == 0 || written > length {
        return Err(io::Error::last_os_error());
    }
    buffer.truncate(written - 1);
    String::from_utf8(buffer).map_err(io::Error::other)
}
