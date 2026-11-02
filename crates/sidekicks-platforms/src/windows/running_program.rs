//! The running program's path as Windows names it, which never marks a file since replaced.

use std::path::Path;

/// Whether the system marks the running program's path as naming a file since replaced: never on
/// Windows, which names the path the program started from.
pub(crate) fn is_program_path_marked_replaced(_program: &Path) -> bool {
    false
}
