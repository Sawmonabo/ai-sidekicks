//! The person's locale as the system names it, for the one category of settings a reader asks
//! about, and the hour cycle their times are shown in; each platform's module reads them.

use icu_locale_core::preferences::extensions::unicode::keywords::HourCycle;

/// The category of the person's settings a locale is read for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocaleCategory {
    /// How numbers are written: grouping and digits.
    Number,
    /// How times are written: the hour cycle among them.
    Time,
    /// The language of messages, which also sets how a list of names is ordered.
    Messages,
}

/// The hour cycle a time pattern's hour field names, quoted text skipped: `h` the 12-hour clock,
/// `K` its 0–11 form, and `H` or `k` the 24-hour clock, the letters CLDR's patterns and Windows'
/// time formats share; `None` for a pattern with no hour.
pub(crate) fn hour_cycle_in_pattern(pattern: &str) -> Option<HourCycle> {
    let mut is_quoted = false;
    for character in pattern.chars() {
        match character {
            '\'' => is_quoted = !is_quoted,
            _ if is_quoted => {}
            'h' => return Some(HourCycle::H12),
            'K' => return Some(HourCycle::H11),
            'H' | 'k' => return Some(HourCycle::H23),
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use icu_locale_core::preferences::extensions::unicode::keywords::HourCycle;
    use rstest::rstest;

    use super::hour_cycle_in_pattern;

    #[rstest]
    #[case::cldr_twelve_hour("h:mm a", Some(HourCycle::H12))]
    #[case::cldr_twenty_four_hour("HH:mm", Some(HourCycle::H23))]
    #[case::cldr_zero_to_eleven("K:mm a", Some(HourCycle::H11))]
    #[case::windows_twelve_hour("h:mm:ss tt", Some(HourCycle::H12))]
    #[case::quoted_letters_skipped("'h' HH 'Uhr'", Some(HourCycle::H23))]
    #[case::no_hour("mm:ss", None)]
    fn the_locale_hour_cycle_is_the_pattern_s_hour_field(
        #[case] pattern: &str,
        #[case] expected: Option<HourCycle>,
    ) {
        assert_eq!(hour_cycle_in_pattern(pattern), expected);
    }
}
