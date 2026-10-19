//! The person's Region setting on macOS, read through Core Foundation when the environment names
//! no locale: the current locale's language and script in the Region the person chose, and the
//! hour cycle of its preferred-hour (`j`) time template, which follows their 24-hour switch.

use std::io;

use icu_locale_core::Locale;
use icu_locale_core::preferences::extensions::unicode::keywords::HourCycle;
use icu_locale_core::subtags::Region;
use objc2_core_foundation::{CFDateFormatter, CFLocale, CFString, kCFLocaleCountryCode};

use crate::posix::system_locale::locale_from_name;
use crate::system_locale::hour_cycle_in_pattern;

/// The locale of the person's Region setting: the current locale's language and script with the
/// Region's country, which its identifier carries only as a keyword (`en_US@rg=dkzzzz` is `en-DK`);
/// `None` when Core Foundation names none ICU reads. A custom number format chosen in System
/// Settings is not part of the locale, so the numbers follow the Region's own format.
pub(crate) fn region_locale() -> Option<Locale> {
    let locale = CFLocale::current()?;
    let identifier = locale.identifier()?.to_string();
    // SAFETY: the key is a constant Core Foundation defines for the life of the process.
    let country_key = unsafe { kCFLocaleCountryCode };
    let country = locale
        .value(country_key)
        .and_then(|value| value.downcast::<CFString>().ok())
        .map(|country| country.to_string());
    locale_in_region(&identifier, country.as_deref())
}

// The locale Core Foundation's `identifier` names, its region replaced by `country` when ICU reads
// that as a region.
fn locale_in_region(identifier: &str, country: Option<&str>) -> Option<Locale> {
    let mut locale = locale_from_name(identifier)?;
    if let Some(region) = country.and_then(|country| Region::try_from_str(country).ok()) {
        locale.id.region = Some(region);
    }
    Some(locale)
}

/// The hour cycle of the person's Region setting, read from the time pattern its `j` template
/// gives. Fails when Core Foundation answers no locale or pattern, or the pattern names no hour.
pub(crate) fn region_hour_cycle() -> io::Result<HourCycle> {
    let locale = CFLocale::current()
        .ok_or_else(|| io::Error::other("Core Foundation names no current locale"))?;
    let template = CFString::from_static_str("j");
    // SAFETY: `None` asks for the default allocator, and the template and the locale outlive the
    // call.
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

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::locale_in_region;

    #[rstest]
    #[case::the_region_keyword_s_country("en_US@rg=dkzzzz", Some("DK"), "en-DK")]
    #[case::the_script_kept("zh_Hans_CN@rg=sgzzzz", Some("SG"), "zh-Hans-SG")]
    #[case::no_country("en", None, "en")]
    #[case::a_country_icu_does_not_read("de_DE", Some(""), "de-DE")]
    fn the_region_locale_takes_the_region_setting_s_country(
        #[case] identifier: &str,
        #[case] country: Option<&str>,
        #[case] expected: &str,
    ) {
        let locale = locale_in_region(identifier, country).expect("the identifier reads");

        assert_eq!(locale.to_string(), expected);
    }
}
