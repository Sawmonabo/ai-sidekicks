//! The person's locale as the system names it, for the one category of settings a reader asks
//! about, and how their times write the hour; each platform's module reads them.

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

/// How the person's times write the hour: its cycle, and whether a one-digit hour takes a leading
/// zero (`03:00` rather than `3:00`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HourField {
    /// The hour cycle.
    pub cycle: HourCycle,
    /// Whether the hour is always two digits.
    pub is_padded: bool,
}

impl HourField {
    /// `hour` (0–23) and `minute` as the person's clock writes them: `14:05` on the 24-hour
    /// clock, `2:05 PM` on the 12-hour one and `0:05 PM` on its 0–11 form, the hour two digits
    /// when the field is padded (`03:00`).
    #[expect(
        clippy::wildcard_enum_match_arm,
        reason = "the hour cycle is an open union; a cycle added to it reads as the 12-hour clock"
    )]
    pub fn time_of_day(self, hour: i8, minute: i8) -> String {
        let (shown_hour, has_period) = match self.cycle {
            HourCycle::H23 | HourCycle::Clock24 => (hour, false),
            HourCycle::H11 => (hour % 12, true),
            _ => ((hour + 11) % 12 + 1, true),
        };
        let width = if self.is_padded { 2 } else { 1 };
        let period = match (has_period, hour < 12) {
            (false, _) => "",
            (true, true) => " AM",
            (true, false) => " PM",
        };
        format!("{shown_hour:0width$}:{minute:02}{period}")
    }
}

/// The hour field a time pattern names, quoted text skipped: `h` the 12-hour clock, `K` its 0–11
/// form, and `H` or `k` the 24-hour clock, the letters CLDR's patterns and Windows' time formats
/// share, padded when the letter is doubled; `None` for a pattern with no hour.
pub(crate) fn hour_field_in_pattern(pattern: &str) -> Option<HourField> {
    let mut is_quoted = false;
    let mut characters = pattern.chars().peekable();
    while let Some(character) = characters.next() {
        let cycle = match character {
            '\'' => {
                is_quoted = !is_quoted;
                continue;
            }
            _ if is_quoted => continue,
            'h' => HourCycle::H12,
            'K' => HourCycle::H11,
            'H' | 'k' => HourCycle::H23,
            _ => continue,
        };
        return Some(HourField {
            cycle,
            is_padded: characters.peek() == Some(&character),
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use icu_locale_core::preferences::extensions::unicode::keywords::HourCycle;
    use rstest::rstest;

    use super::{HourField, hour_field_in_pattern};

    // Mutations: read a doubled letter as one digit, or a single letter as two.
    #[rstest]
    #[case::cldr_twelve_hour("h:mm a", Some((HourCycle::H12, false)))]
    #[case::cldr_twenty_four_hour("HH:mm", Some((HourCycle::H23, true)))]
    #[case::unpadded_twenty_four_hour("H.mm", Some((HourCycle::H23, false)))]
    #[case::cldr_zero_to_eleven("K:mm a", Some((HourCycle::H11, false)))]
    #[case::windows_twelve_hour("h:mm:ss tt", Some((HourCycle::H12, false)))]
    #[case::quoted_letters_skipped("'hh' H 'Uhr'", Some((HourCycle::H23, false)))]
    #[case::no_hour("mm:ss", None)]
    fn the_locale_hour_field_is_the_pattern_s(
        #[case] pattern: &str,
        #[case] expected: Option<(HourCycle, bool)>,
    ) {
        assert_eq!(
            hour_field_in_pattern(pattern),
            expected.map(|(cycle, is_padded)| HourField { cycle, is_padded })
        );
    }

    // Mutations: write every cycle on one clock, pad the hour whatever the field says, count the
    // 0–11 form from 1, or put midnight or noon on the wrong side of the period.
    #[rstest]
    #[case::twelve_hour(HourCycle::H12, false, 3, 0, "3:00 AM")]
    #[case::padded_twelve_hour(HourCycle::H12, true, 14, 5, "02:05 PM")]
    #[case::twelve_hour_midnight(HourCycle::H12, false, 0, 5, "12:05 AM")]
    #[case::twelve_hour_noon(HourCycle::H12, false, 12, 5, "12:05 PM")]
    #[case::zero_to_eleven_midnight(HourCycle::H11, false, 0, 5, "0:05 AM")]
    #[case::zero_to_eleven_noon(HourCycle::H11, false, 12, 5, "0:05 PM")]
    #[case::twenty_four_hour(HourCycle::H23, true, 3, 0, "03:00")]
    #[case::unpadded_twenty_four_hour(HourCycle::H23, false, 3, 0, "3:00")]
    #[case::twenty_four_hour_afternoon(HourCycle::H23, true, 14, 5, "14:05")]
    #[case::locale_chosen_twenty_four_hour(HourCycle::Clock24, true, 0, 5, "00:05")]
    fn a_time_of_day_is_written_on_the_hour_field_s_clock(
        #[case] cycle: HourCycle,
        #[case] is_padded: bool,
        #[case] hour: i8,
        #[case] minute: i8,
        #[case] expected: &str,
    ) {
        assert_eq!(
            HourField { cycle, is_padded }.time_of_day(hour, minute),
            expected
        );
    }
}
