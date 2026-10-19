//! The bound on one argument a program starts with on Windows, from the command line's length.

use std::io;

use crate::path::rules::windows::command_line::COMMAND_LINE_UNITS;

// The most UTF-8 bytes one UTF-16 unit stands for: U+0800 to U+FFFF take 3 bytes in one unit, and
// a surrogate pair 4 bytes in two.
const UTF8_BYTES_PER_UNIT: usize = 3;

/// A bound in bytes that no single argument a program can start with reaches: 32,767 UTF-16 units
/// at 3 UTF-8 bytes each, since an argument of that many bytes needs at least the whole command
/// line. Never fails.
pub fn read_command_argument_limit() -> io::Result<usize> {
    Ok(COMMAND_LINE_UNITS * UTF8_BYTES_PER_UNIT)
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use windows_sys::Win32::Foundation::ERROR_FILENAME_EXCED_RANGE;

    use super::read_command_argument_limit;

    // `CreateProcessW` refuses a command line past 32,767 units with `ERROR_FILENAME_EXCED_RANGE`;
    // std passes the line on unchecked, so the error is the system's.
    #[test]
    fn a_program_given_one_argument_past_the_limit_does_not_start() {
        let limit = read_command_argument_limit().expect("the limit reads");
        let program = std::env::current_exe().expect("this test's program path");

        let refusal = Command::new(program)
            .arg("a".repeat(limit + 1))
            .status()
            .expect_err("the program does not start");

        assert_eq!(
            refusal.raw_os_error(),
            Some(ERROR_FILENAME_EXCED_RANGE.cast_signed())
        );
    }
}
