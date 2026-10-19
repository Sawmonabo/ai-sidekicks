//! The person's locale on macOS and Linux, read from the environment in the order POSIX gives it
//! (`LC_ALL`, then the category's own variable, then `LANG`, the first that is set and not empty)
//! without calling `setlocale`, so the environment is the whole answer; `C`, `POSIX`, a value ICU
//! cannot read and no value at all are the POSIX locale. The hour cycle is the one the locale's
//! CLDR time pattern names.

use std::ffi::OsString;
use std::io;

use icu_datetime::NoCalendarFormatter;
use icu_datetime::fieldsets::T;
use icu_datetime::input::Time;
use icu_locale_core::Locale;
use icu_locale_core::preferences::extensions::unicode::keywords::HourCycle;

use crate::system_locale::{LocaleCategory, hour_cycle_in_pattern};

/// The person's locale for `category`, from this process's environment; `None` for the POSIX
/// locale, whose numbers are plain digits.
pub fn system_locale(category: LocaleCategory) -> Option<Locale> {
    resolve_system_locale(|name| std::env::var_os(name), category)
}

/// The hour cycle of the person's times: the one the CLDR time pattern of their `Time` locale
/// names, and the 24-hour clock for the POSIX locale. Fails when the locale's time pattern cannot
/// be loaded or names no hour.
pub fn system_hour_cycle() -> io::Result<HourCycle> {
    hour_cycle_of(system_locale(LocaleCategory::Time).as_ref())
}

/// The locale for `category` with the environment read through `read_variable`.
pub(crate) fn resolve_system_locale(
    read_variable: impl Fn(&str) -> Option<OsString>,
    category: LocaleCategory,
) -> Option<Locale> {
    let category_variable = match category {
        LocaleCategory::Number => "LC_NUMERIC",
        LocaleCategory::Time => "LC_TIME",
    };
    let value = ["LC_ALL", category_variable, "LANG"]
        .into_iter()
        .find_map(|name| read_variable(name).filter(|value| !value.is_empty()))?;
    // A POSIX locale name is `language[_territory][.codeset][@modifier]`; the codeset and the
    // modifier name no format, and ICU separates subtags with `-`.
    let name = value.to_str()?.split(['.', '@']).next()?;
    if name == "C" || name == "POSIX" {
        return None;
    }
    Locale::try_from_str(&name.replace('_', "-")).ok()
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

    use super::{hour_cycle_of, resolve_system_locale};
    use crate::system_locale::LocaleCategory;

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
    #[case::c_is_plain(&[("LC_ALL", "C"), ("LANG", "de_DE.UTF-8")], LocaleCategory::Number, None)]
    #[case::c_with_a_codeset_is_plain(&[("LANG", "C.UTF-8")], LocaleCategory::Number, None)]
    #[case::posix_is_plain(&[("LC_NUMERIC", "POSIX")], LocaleCategory::Number, None)]
    #[case::an_unreadable_name_is_plain(&[("LANG", "not a locale")], LocaleCategory::Number, None)]
    #[case::nothing_set(&[], LocaleCategory::Time, None)]
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

        let locale = resolve_system_locale(read_variable, category);

        assert_eq!(locale.map(|locale| locale.to_string()).as_deref(), expected);
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
