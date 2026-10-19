//! Text a program passes on as bytes on Windows, whose own text is UTF-16: its UTF-8.

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
