//! The account's login shell on Windows, which has none.

use std::io;
use std::path::PathBuf;

/// The account's login shell: always `None`, since Windows names none. Never fails.
pub fn login_shell() -> io::Result<Option<PathBuf>> {
    Ok(None)
}
