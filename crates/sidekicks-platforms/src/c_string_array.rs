//! The arrays of C strings a C program's arguments and environment pass as.

use std::ffi::{CString, c_char};

/// Pointers to `strings`, then the null pointer an `argv` or `envp` array ends with, as C's `main`
/// and `posix_spawn` take them; valid as long as `strings` lives unchanged.
pub fn null_terminated_pointers(strings: &[CString]) -> Vec<*mut c_char> {
    strings
        .iter()
        .map(|string| string.as_ptr().cast_mut())
        .chain(std::iter::once(std::ptr::null_mut()))
        .collect()
}
