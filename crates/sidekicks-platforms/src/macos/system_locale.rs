//! The person's Region setting on macOS, read through Core Foundation when the environment names
//! no locale: the current locale, with the formats the person chose laid over it, and the hour
//! cycle of its preferred-hour (`j`) time template, which follows their 24-hour switch.

use std::io;

use icu_locale_core::Locale;
use icu_locale_core::preferences::extensions::unicode::keywords::HourCycle;
use objc2_core_foundation::{CFDateFormatter, CFLocale, CFString};

use crate::posix::system_locale::locale_from_name;
use crate::system_locale::hour_cycle_in_pattern;

/// The locale of the person's Region setting; `None` when Core Foundation names none ICU reads.
pub(crate) fn region_locale() -> Option<Locale> {
    let identifier = CFLocale::current()?.identifier()?.to_string();
    locale_from_name(&identifier)
}

/// The hour cycle of the person's Region setting, read from the time pattern its `j` template
/// gives. Fails when Core Foundation answers no locale or pattern, or the pattern names no hour.
pub(crate) fn region_hour_cycle() -> io::Result<HourCycle> {
    let locale = CFLocale::current()
        .ok_or_else(|| io::Error::other("Core Foundation names no current locale"))?;
    let template = CFString::from_static_str("j");
    // SAFETY: no allocator is the default one, and the template and the locale are live.
    let pattern = unsafe {
        CFDateFormatter::new_date_format_from_template(None, Some(&template), 0, Some(&locale))
    }
    .ok_or_else(|| io::Error::other("Core Foundation answers no pattern for the `j` template"))?
    .to_string();
    hour_cycle_in_pattern(&pattern).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("the Region setting's time pattern {pattern:?} names no hour"),
        )
    })
}
