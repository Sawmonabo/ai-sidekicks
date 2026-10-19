//! The person's Region setting on macOS, read through Core Foundation when the environment names
//! no locale: the current locale's language, script and Numbers choice in the Region the person
//! chose, and the hour cycle of its preferred-hour (`j`) time template, which follows their
//! 24-hour switch.

use std::io;

use icu_locale_core::Locale;
use icu_locale_core::extensions::unicode::{Value, key};
use icu_locale_core::preferences::extensions::unicode::keywords::{HourCycle, NumberingSystem};
use icu_locale_core::subtags::Region;
use objc2_core_foundation::{CFDateFormatter, CFLocale, CFString, kCFLocaleCountryCode};

use crate::posix::system_locale::locale_from_name;
use crate::system_locale::hour_cycle_in_pattern;

/// The locale of the person's Region setting: the current locale's language and script with the
/// Region's country, which its identifier carries only as a keyword (`en_US@rg=dkzzzz` is `en-DK`),
/// and the digits of its Numbers choice (`en_US@numbers=arab` is `en-US-u-nu-arab`); `None` when
/// Core Foundation names none ICU reads. Custom separators chosen in System Settings
/// (`AppleICUNumberSymbols`) are not part of the locale.
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
// that as a region, and its `numbers` keyword kept as its numbering system when ICU reads one.
fn locale_in_region(identifier: &str, country: Option<&str>) -> Option<Locale> {
    let mut locale = locale_from_name(identifier)?;
    if let Some(region) = country.and_then(|country| Region::try_from_str(country).ok()) {
        locale.id.region = Some(region);
    }
    if let Some(numbering_system) = numbering_system_in(identifier) {
        locale
            .extensions
            .unicode
            .keywords
            .set(key!("nu"), numbering_system.into());
    }
    Some(locale)
}

// The numbering system the identifier's `numbers` keyword names (`key=value` pairs after `@`,
// joined by `;`), when ICU reads it as one.
fn numbering_system_in(identifier: &str) -> Option<NumberingSystem> {
    let (_, keywords) = identifier.split_once('@')?;
    let numbers = keywords
        .split(';')
        .find_map(|keyword| keyword.strip_prefix("numbers="))?;
    let value = Value::try_from_str(numbers).ok()?;
    NumberingSystem::try_from(&value).ok()
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
    #[case::the_numbers_choice_kept("en_US@numbers=arab;rg=dkzzzz", Some("DK"), "en-DK-u-nu-arab")]
    #[case::western_digits_where_the_region_s_differ(
        "ar_SA@numbers=latn",
        Some("SA"),
        "ar-SA-u-nu-latn"
    )]
    #[case::no_country("en", None, "en")]
    #[case::a_country_icu_does_not_read("de_DE", Some(""), "de-DE")]
    fn the_region_locale_follows_the_region_setting(
        #[case] identifier: &str,
        #[case] country: Option<&str>,
        #[case] expected: &str,
    ) {
        let locale = locale_in_region(identifier, country).expect("the identifier reads");

        assert_eq!(locale.to_string(), expected);
    }
}
