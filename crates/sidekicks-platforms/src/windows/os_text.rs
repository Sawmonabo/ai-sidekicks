//! Text a program passes on as bytes on Windows, whose own text is UTF-16: its UTF-8, and for tests
//! a name that is not Unicode.

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

/// A file name that is not Unicode: `stem` followed by the lone low surrogate `0xDC00 + unit`, so
/// names given different `unit`s differ only in that unit. `unit` is below 64.
#[cfg(any(test, feature = "test-support"))]
pub fn non_unicode_name(stem: &str, unit: u8) -> std::ffi::OsString {
    use std::os::windows::ffi::OsStringExt as _;

    let mut units: Vec<u16> = stem.encode_utf16().collect();
    units.push(0xDC00 + u16::from(unit));
    std::ffi::OsString::from_wide(&units)
}
