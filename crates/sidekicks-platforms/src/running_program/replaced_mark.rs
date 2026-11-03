//! The running program's path on a system that names the path the program started from, which
//! never marks a file since replaced.

use std::path::Path;

/// Whether the system marks the running program's path as naming a file since replaced: never on
/// macOS or Windows, which name the path the program started from.
pub(crate) fn is_program_path_marked_replaced(_program: &Path) -> bool {
    false
}
