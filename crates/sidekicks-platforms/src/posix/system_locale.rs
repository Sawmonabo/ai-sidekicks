//! The person's locale on macOS and Linux, read from the environment in the order POSIX gives it
//! (`LC_ALL`, then the category's own variable, then `LANG`, the first that is set and not empty)
//! without calling `setlocale`; `C`, `POSIX` and a value ICU cannot read are the POSIX locale. When
//! none of the three is set, macOS answers the Region setting the person chose, which a program
//! the system starts sees with no `LANG`, and Linux the POSIX locale. The hour cycle is the one the
//! locale's CLDR time pattern names.

use std::ffi::OsString;
use std::io;

use icu_datetime::NoCalendarFormatter;
use icu_datetime::fieldsets::T;
use icu_datetime::input::Time;
use icu_locale_core::Locale;
use icu_locale_core::preferences::extensions::unicode::keywords::HourCycle;

use crate::system_locale::{LocaleCategory, hour_cycle_in_pattern};

/// The person's locale for `category`; `None` for the POSIX locale, whose numbers are plain
/// digits.
pub fn system_locale(category: LocaleCategory) -> Option<Locale> {
    match environment_locale(|name| std::env::var_os(name), category) {
        EnvironmentLocale::Named(locale) => Some(locale),
        EnvironmentLocale::Posix => None,
        #[cfg(target_os = "macos")]
        EnvironmentLocale::Unset => crate::macos::system_locale::region_locale(),
        #[cfg(target_os = "linux")]
        EnvironmentLocale::Unset => None,
    }
}

/// The hour cycle of the person's times: the one the CLDR time pattern of their `Time` locale
/// names, and the 24-hour clock for the POSIX locale. Fails when the locale's time pattern cannot
/// be loaded or names no hour.
pub fn system_hour_cycle() -> io::Result<HourCycle> {
    match environment_locale(|name| std::env::var_os(name), LocaleCategory::Time) {
        EnvironmentLocale::Named(locale) => hour_cycle_of(Some(&locale)),
        EnvironmentLocale::Posix => hour_cycle_of(None),
        #[cfg(target_os = "macos")]
        EnvironmentLocale::Unset => crate::macos::system_locale::region_hour_cycle(),
        #[cfg(target_os = "linux")]
        EnvironmentLocale::Unset => hour_cycle_of(None),
    }
}

/// What the environment names for one category of the person's settings.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum EnvironmentLocale {
    /// A locale ICU reads.
    Named(Locale),
    /// `C`, `POSIX` or a value ICU cannot read: the POSIX locale.
    Posix,
    /// None of `LC_ALL`, the category's variable and `LANG` is set and not empty.
    Unset,
}

/// What the environment, read through `read_variable`, names for `category`.
pub(crate) fn environment_locale(
    read_variable: impl Fn(&str) -> Option<OsString>,
    category: LocaleCategory,
) -> EnvironmentLocale {
    let category_variable = match category {
        LocaleCategory::Number => "LC_NUMERIC",
        LocaleCategory::Time => "LC_TIME",
        LocaleCategory::Messages => "LC_MESSAGES",
    };
    let Some(value) = ["LC_ALL", category_variable, "LANG"]
        .into_iter()
        .find_map(|name| read_variable(name).filter(|value| !value.is_empty()))
    else {
        return EnvironmentLocale::Unset;
    };
    value
        .to_str()
        .filter(|name| !is_posix_locale_name(name))
        .and_then(locale_from_name)
        .map_or(EnvironmentLocale::Posix, EnvironmentLocale::Named)
}

/// The locale a POSIX or Core Foundation locale name gives (`language[_territory][.codeset]
/// [@modifier]`): the codeset and the modifier name no format, and ICU separates subtags with `-`;
/// `None` for a name ICU cannot read.
pub(crate) fn locale_from_name(name: &str) -> Option<Locale> {
    let tag = name.split(['.', '@']).next()?;
    Locale::try_from_str(&tag.replace('_', "-")).ok()
}

// Whether `name`, its codeset and modifier aside, selects the POSIX locale.
fn is_posix_locale_name(name: &str) -> bool {
    matches!(name.split(['.', '@']).next(), Some("C" | "POSIX"))
}

/// The hour cycle the CLDR time pattern of `locale` names, the 24-hour clock for the POSIX
/// locale (`None`).
pub(crate) fn hour_cycle_of(locale: Option<&Locale>) -> io::Result<HourCycle> {
    let Some(locale) = locale else {
        return Ok(HourCycle::H23);
    };
    let formatter =
        NoCalendarFormatter::try_new(locale.into(), T::hm()).map_err(io::Error::other)?;
    let noon = Time::try_new(12, 0, 0, 0).map_err(io::Error::other)?;
    let pattern = formatter.format(&noon).pattern().to_string();
    hour_cycle_in_pattern(&pattern).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("the time pattern {pattern:?} of {locale} names no hour"),
        )
    })
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use icu_locale_core::preferences::extensions::unicode::keywords::HourCycle;
    use rstest::rstest;

    use super::{EnvironmentLocale, environment_locale, hour_cycle_of};
    use crate::system_locale::LocaleCategory;

    // `Some(tag)` for a named locale, `Some("")` for the POSIX locale, `None` for no setting.
    #[rstest]
    #[case::lc_all_first(
        &[("LC_ALL", "de_DE.UTF-8"), ("LC_NUMERIC", "fr_FR"), ("LANG", "en_US")],
        LocaleCategory::Number,
        Some("de-DE")
    )]
    #[case::an_empty_lc_all_is_unset(
        &[("LC_ALL", ""), ("LC_NUMERIC", "fr_FR.UTF-8")],
        LocaleCategory::Number,
        Some("fr-FR")
    )]
    #[case::the_category_s_own_variable(
        &[("LC_NUMERIC", "fr_FR"), ("LC_TIME", "en_GB"), ("LANG", "en_US")],
        LocaleCategory::Time,
        Some("en-GB")
    )]
    #[case::lang_last(
        &[("LC_TIME", "en_GB"), ("LANG", "hi_IN.UTF-8")],
        LocaleCategory::Number,
        Some("hi-IN")
    )]
    #[case::the_modifier_dropped(
        &[("LANG", "de_DE.ISO-8859-15@euro")],
        LocaleCategory::Time,
        Some("de-DE")
    )]
    #[case::c_is_plain(
        &[("LC_ALL", "C"), ("LANG", "de_DE.UTF-8")],
        LocaleCategory::Number,
        Some("")
    )]
    #[case::c_with_a_codeset_is_plain(&[("LANG", "C.UTF-8")], LocaleCategory::Number, Some(""))]
    #[case::posix_is_plain(&[("LC_NUMERIC", "POSIX")], LocaleCategory::Number, Some(""))]
    #[case::an_unreadable_name_is_plain(
        &[("LANG", "not a locale")],
        LocaleCategory::Number,
        Some("")
    )]
    #[case::nothing_set_falls_back(&[], LocaleCategory::Time, None)]
    #[case::only_empty_values_fall_back(
        &[("LC_ALL", ""), ("LC_NUMERIC", ""), ("LANG", "")],
        LocaleCategory::Number,
        None
    )]
    fn the_system_locale_follows_the_posix_order(
        #[case] environment: &[(&str, &str)],
        #[case] category: LocaleCategory,
        #[case] expected: Option<&str>,
    ) {
        let read_variable = |name: &str| {
            environment
                .iter()
                .find(|(set_name, _)| *set_name == name)
                .map(|(_, value)| OsString::from(value))
        };

        let locale = environment_locale(read_variable, category);

        let read = match locale {
            EnvironmentLocale::Named(locale) => Some(locale.to_string()),
            EnvironmentLocale::Posix => Some(String::new()),
            EnvironmentLocale::Unset => None,
        };
        assert_eq!(read.as_deref(), expected);
    }

    #[rstest]
    #[case::the_us_twelve_hour_clock(Some("en-US"), HourCycle::H12)]
    #[case::germany_s_twenty_four_hour_clock(Some("de-DE"), HourCycle::H23)]
    #[case::the_posix_locale(None, HourCycle::H23)]
    fn the_hour_cycle_is_the_locale_time_pattern_s(
        #[case] locale: Option<&str>,
        #[case] expected: HourCycle,
    ) {
        let locale = locale.map(|tag| tag.parse().expect("a locale"));

        let hour_cycle = hour_cycle_of(locale.as_ref()).expect("the pattern loads");

        assert_eq!(hour_cycle, expected);
    }
}
