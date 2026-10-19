//! Text as the UTF-16 units Windows' calls take, refused when it holds a NUL, which ends a string
//! there and would cut it short.

use std::ffi::OsStr;
use std::io::{self, ErrorKind};
use std::os::windows::ffi::OsStrExt as _;

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
