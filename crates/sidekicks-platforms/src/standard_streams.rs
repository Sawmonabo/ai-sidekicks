//! The process's standard streams as raw bytes: Windows' C runtime opens standard input and output
//! in text mode, which ends input at the byte `0x1A` and writes each newline as `\r\n`; macOS and
//! Linux have no text mode.

use std::io;

/// Puts standard input and output in binary mode, before a C program reads or writes them, so
/// every byte passes as it is: on Windows through the C runtime's `_setmode`; nothing on macOS and
/// Linux. Fails with `InvalidInput` when the C runtime refuses.
pub fn set_binary_standard_streams() -> io::Result<()> {
    #[cfg(target_os = "windows")]
    return crate::windows::standard_streams::set_binary_standard_streams();
    #[cfg(unix)]
    Ok(())
}
