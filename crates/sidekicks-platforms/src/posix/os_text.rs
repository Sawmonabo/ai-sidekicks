//! Text the system hands a program as bytes on macOS and Linux: an argument's, a path's or an
//! environment entry's own bytes, whatever they hold.

use std::borrow::Cow;
use std::ffi::OsStr;
use std::io;
use std::os::unix::ffi::OsStrExt;

/// `text`'s bytes as the system hands them to a program: its own bytes, never converted. Never
/// fails.
pub fn os_text_bytes(text: &OsStr) -> io::Result<Cow<'_, [u8]>> {
    Ok(Cow::Borrowed(text.as_bytes()))
}
