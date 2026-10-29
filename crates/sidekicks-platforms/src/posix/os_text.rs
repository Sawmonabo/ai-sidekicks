//! Text the system hands a program as bytes on macOS and Linux: an argument's, a path's or an
//! environment entry's own bytes, whatever they hold, the byte form a record stores, and for tests
//! a name that is not Unicode.

use std::borrow::Cow;
use std::ffi::OsStr;
use std::io;
use std::os::unix::ffi::OsStrExt;

/// `text`'s bytes as the system hands them to a program: its own bytes, never converted. Never
/// fails.
pub fn os_text_bytes(text: &OsStr) -> io::Result<Cow<'_, [u8]>> {
    Ok(Cow::Borrowed(text.as_bytes()))
}

/// `text`'s stable byte form, the same for the same text on every build for this system, so it
/// can be stored and compared later: its own bytes.
pub fn os_text_stable_bytes(text: &OsStr) -> Cow<'_, [u8]> {
    Cow::Borrowed(text.as_bytes())
}

/// A file name that is not Unicode: `stem` followed by the lone continuation byte `0x80 + unit`,
/// so names given different `unit`s differ only in that byte. `unit` must be below 64, which keeps
/// that byte a continuation byte; a debug build panics on any other.
#[cfg(any(test, feature = "test-support"))]
pub fn non_unicode_name(stem: &str, unit: u8) -> std::ffi::OsString {
    use std::os::unix::ffi::OsStringExt as _;

    debug_assert!(unit < 64, "a continuation byte's unit is below 64");
    let mut bytes = stem.as_bytes().to_vec();
    bytes.push(0x80 + unit);
    std::ffi::OsString::from_vec(bytes)
}
