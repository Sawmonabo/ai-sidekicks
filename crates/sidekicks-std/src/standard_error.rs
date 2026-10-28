//! The program's standard error, where a line goes when nothing else is left to tell: before the
//! program's log starts, after it failed, or in a helper mode, which has none.

use std::io::{self, Write as _};

/// Writes `line` to standard error. A failed write is dropped: nothing is left to tell, and the
/// exit status still says what failed.
pub fn write_error_line(line: &str) {
    if let Err(error) = writeln!(io::stderr().lock(), "{line}") {
        drop(error);
    }
}
