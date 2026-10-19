//! Text as the UTF-16 units Windows' calls take, refused when it holds a NUL, which ends a string
//! there and would cut it short, and a NUL-terminated string a call answers, read back.

use std::ffi::{OsStr, OsString};
use std::io::{self, ErrorKind};
use std::os::windows::ffi::{OsStrExt as _, OsStringExt as _};

use windows_sys::core::PWSTR;

/// Fails with `InvalidInput` for text holding a NUL, which ends a string in Windows' calls.
pub(crate) fn refuse_nul(text: &OsStr) -> io::Result<()> {
    // In the WTF-8 bytes Windows text is kept in, a 0 byte is only ever U+0000.
    if text.as_encoded_bytes().contains(&0) {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            "a text Windows is given holds a NUL",
        ));
    }
    Ok(())
}

/// `text` as UTF-16 units, without an ending NUL; fails with `InvalidInput` for text holding a NUL.
pub(crate) fn wide_text(text: &OsStr) -> io::Result<Vec<u16>> {
    refuse_nul(text)?;
    Ok(text.encode_wide().collect())
}

/// The NUL-terminated wide string at `text`, copied without its NUL.
///
/// # Safety
///
/// `text` points at a live NUL-terminated wide string.
pub(crate) unsafe fn read_wide_string(text: PWSTR) -> OsString {
    let mut length = 0;
    // SAFETY: every unit up to and including the NUL lies inside the string.
    while unsafe { *text.add(length) } != 0 {
        length += 1;
    }
    // SAFETY: the `length` units before the NUL are the string's, initialized and live.
    OsString::from_wide(unsafe { std::slice::from_raw_parts(text, length) })
}
