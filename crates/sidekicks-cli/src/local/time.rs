//! Times as the person's clock shows them: this computer's time zone and its hour cycle, read once
//! per command, then each instant the daemon sends written on that clock.

use anyhow::Context as _;
use icu_locale_core::preferences::extensions::unicode::keywords::HourCycle;
use jiff::Zoned;
use jiff::tz::TimeZone;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_platforms::system_hour_cycle;

/// This computer's time zone and hour cycle, which every time a command prints is written in.
pub(crate) struct LocalClock {
    time_zone: TimeZone,
    hour_cycle: HourCycle,
}

impl LocalClock {
    /// Reads this computer's time zone and hour cycle; fails as either read does.
    pub(crate) fn read() -> anyhow::Result<Self> {
        let time_zone =
            TimeZone::try_system().context("could not read this computer's time zone")?;
        let hour_cycle =
            system_hour_cycle().context("could not read how this computer shows times")?;
        Ok(Self {
            time_zone,
            hour_cycle,
        })
    }

    /// `instant`'s date and time of day, `2026-10-29 2:05 PM`; an instant this clock cannot place
    /// prints its wire text.
    pub(crate) fn date_and_time(&self, instant: &WireInstant) -> String {
        self.written(instant, |zoned| {
            format!("{} {}", zoned.date(), self.time_of_day(zoned))
        })
    }

    /// `instant`'s time of day, `2:05 PM`; an instant this clock cannot place prints its wire
    /// text.
    pub(crate) fn time(&self, instant: &WireInstant) -> String {
        self.written(instant, |zoned| self.time_of_day(zoned))
    }

    fn written(&self, instant: &WireInstant, write: impl FnOnce(&Zoned) -> String) -> String {
        instant.timestamp().map_or_else(
            || instant.as_str().to_owned(),
            |timestamp| write(&timestamp.to_zoned(self.time_zone.clone())),
        )
    }

    /// `zoned`'s time of day: `14:05` on a 24-hour clock, `2:05 PM` on a 12-hour one, `0:05 PM` on
    /// the one that counts from 0 to 11.
    fn time_of_day(&self, zoned: &Zoned) -> String {
        let (hour, minute) = (zoned.hour(), zoned.minute());
        // `HourCycle` is non-exhaustive, so it is compared rather than matched.
        if self.hour_cycle == HourCycle::H23 || self.hour_cycle == HourCycle::Clock24 {
            return format!("{hour:02}:{minute:02}");
        }
        let period = if hour < 12 { "AM" } else { "PM" };
        let shown_hour = if self.hour_cycle == HourCycle::H11 {
            hour % 12
        } else {
            (hour + 11) % 12 + 1
        };
        format!("{shown_hour}:{minute:02} {period}")
    }
}
