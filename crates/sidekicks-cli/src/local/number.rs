//! Counts as the person's number format writes them: this computer's number locale, read once per
//! command, then each count grouped as that locale groups digits.

use icu_decimal::DecimalFormatter;
use icu_decimal::input::Decimal;
use icu_decimal::options::DecimalFormatterOptions;
use icu_locale_core::Locale;
use sidekicks_platforms::{LocaleCategory, system_locale};

/// This computer's number format, which every count a command prints is written in.
pub(crate) struct LocalNumberFormat {
    /// `None` for the POSIX locale, whose counts are plain digits.
    formatter: Option<DecimalFormatter>,
}

impl LocalNumberFormat {
    /// Reads this computer's number locale.
    pub(crate) fn read() -> Self {
        Self::of_locale(system_locale(LocaleCategory::Number).as_ref())
    }

    /// The number format of `locale`, plain digits for the POSIX locale (`None`).
    pub(crate) fn of_locale(locale: Option<&Locale>) -> Self {
        let formatter = locale.map(|locale| {
            DecimalFormatter::try_new(locale.into(), DecimalFormatterOptions::default())
                .expect("the compiled number data covers every locale through its fallback")
        });
        Self { formatter }
    }

    /// `count` grouped as this format writes numbers, `1,204` in English.
    pub(crate) fn count(&self, count: u64) -> String {
        match &self.formatter {
            Some(formatter) => formatter.format(&Decimal::from(count)).to_string(),
            None => count.to_string(),
        }
    }
}
