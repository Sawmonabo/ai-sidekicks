//! The running program's path as Linux names it, which marks a file since replaced.

use std::path::Path;

/// Whether Linux's link to the running program names a file since replaced or removed, which the
/// kernel marks by ending the path with ` (deleted)`.
pub(crate) fn is_program_path_marked_replaced(program: &Path) -> bool {
    program
        .as_os_str()
        .as_encoded_bytes()
        .ends_with(b" (deleted)")
}
