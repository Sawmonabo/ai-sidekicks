//! Text a program passes on as bytes on Windows, whose own text is UTF-16: its UTF-8, the byte form
//! a record stores, and for tests a name that is not Unicode.

use std::borrow::Cow;
use std::ffi::OsStr;
use std::io;

/// `text` as UTF-8 bytes. Fails with `InvalidData` for text that is not Unicode, which no byte form
/// carries exactly.
pub fn os_text_bytes(text: &OsStr) -> io::Result<Cow<'_, [u8]>> {
    text.to_str()
        .map(|text| Cow::Borrowed(text.as_bytes()))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("{} is not Unicode", text.display()),
            )
        })
}

/// `text`'s stable byte form, the same for the same text on every build for this system, so it
/// can be stored and compared later: its UTF-16 units, each as two little-endian bytes.
pub fn os_text_stable_bytes(text: &OsStr) -> Cow<'_, [u8]> {
    use std::os::windows::ffi::OsStrExt as _;

    Cow::Owned(text.encode_wide().flat_map(u16::to_le_bytes).collect())
}

/// A file name that is not Unicode: `stem` followed by the lone low surrogate `0xDC00 + unit`, so
/// names given different `unit`s differ only in that unit. `unit` must be below 64, which keeps
/// that unit a low surrogate; a debug build panics on any other.
#[cfg(any(test, feature = "test-support"))]
pub fn non_unicode_name(stem: &str, unit: u8) -> std::ffi::OsString {
    use std::os::windows::ffi::OsStringExt as _;

    debug_assert!(unit < 64, "a low surrogate's unit is below 64");
    let mut units: Vec<u16> = stem.encode_utf16().collect();
    units.push(0xDC00 + u16::from(unit));
    std::ffi::OsString::from_wide(&units)
}
