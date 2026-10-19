//! The user-namespace check on a system with no user namespaces.

use std::io;

/// Whether this user may make a Linux user namespace: never on this system, which has none.
/// Never fails.
pub fn can_create_user_namespace() -> io::Result<bool> {
    Ok(false)
}
