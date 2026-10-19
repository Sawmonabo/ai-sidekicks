//! The account's login shell on Windows, which has none.

use std::io;
use std::path::{Path, PathBuf};

use tokio::process::Command;

/// The account's login shell: always `None`, since Windows names none. Never fails.
pub fn login_shell() -> io::Result<Option<PathBuf>> {
    Ok(None)
}

/// Leaves `command` as it is: Windows has no login shell, and a program's command line has no
/// separate name to set.
pub fn name_as_login_shell(_command: &mut Command, _shell: &Path) {}
