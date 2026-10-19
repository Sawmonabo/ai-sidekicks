//! The person's locale on Windows: the user's default locale, which Windows keeps one of for every
//! category, read with `GetLocaleInfoEx`, and the hour cycle its time format names.

use std::io;

use icu_locale_core::Locale;
use icu_locale_core::preferences::extensions::unicode::keywords::HourCycle;
use windows_sys::Win32::Globalization::{GetLocaleInfoEx, LOCALE_SNAME, LOCALE_STIMEFORMAT};
use windows_sys::Win32::System::SystemServices::LOCALE_NAME_MAX_LENGTH;

use crate::system_locale::{LocaleCategory, hour_cycle_in_pattern};

// The longest time format `GetLocaleInfoEx` answers, in UTF-16 units with its NUL.
const TIME_FORMAT_MAX_LENGTH: usize = 80;

/// The user's default locale, the same for every category on Windows, its alternate sort
/// (`de-DE_phoneb`) aside; `None` when the system names none ICU can read, whose numbers are plain
/// digits.
pub fn system_locale(_category: LocaleCategory) -> Option<Locale> {
    let name = read_locale_info::<{ LOCALE_NAME_MAX_LENGTH as usize }>(LOCALE_SNAME).ok()?;
    let tag = name.split('_').next()?;
    Locale::try_from_str(tag).ok()
}

/// The hour cycle the user's time format (`LOCALE_STIMEFORMAT`, the form Windows prefers over
/// `LOCALE_ITIME`) names: `h` the 12-hour clock and `H` the 24-hour clock. Fails when the format
/// cannot be read or names no hour.
pub fn system_hour_cycle() -> io::Result<HourCycle> {
    let format = read_locale_info::<TIME_FORMAT_MAX_LENGTH>(LOCALE_STIMEFORMAT)?;
    hour_cycle_in_pattern(&format).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("the user's time format {format:?} names no hour"),
        )
    })
}

// The user's default locale's value for `kind`, at most `LENGTH` UTF-16 units with its NUL.
fn read_locale_info<const LENGTH: usize>(kind: u32) -> io::Result<String> {
    let mut buffer = [0_u16; LENGTH];
    let capacity = i32::try_from(LENGTH).map_err(io::Error::other)?;
    // SAFETY: a null name asks for the user's default locale, and the call writes at most
    // `capacity` units into the live buffer.
    let written = unsafe { GetLocaleInfoEx(std::ptr::null(), kind, buffer.as_mut_ptr(), capacity) };
    // The count includes the ending NUL; 0 is a failure.
    let length = usize::try_from(written).map_err(io::Error::other)?;
    let Some(text_length) = length.checked_sub(1) else {
        return Err(io::Error::last_os_error());
    };
    String::from_utf16(&buffer[..text_length])
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}
