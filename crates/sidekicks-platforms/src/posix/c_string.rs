//! An operating-system string as the C string a system call takes.

use std::ffi::{CString, OsStr};
use std::io;
use std::os::unix::ffi::OsStrExt as _;

/// `text` as a C string; `InvalidInput` when it holds a NUL.
pub(crate) fn c_string(text: &OsStr) -> io::Result<CString> {
    CString::new(text.as_bytes()).map_err(io::Error::from)
}
