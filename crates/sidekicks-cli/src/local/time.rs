//! Times as the person's clock shows them: this computer's time zone and its hour field, read once
//! per command, then each instant the daemon sends written on that clock.

use anyhow::Context as _;
use jiff::Zoned;
use jiff::tz::TimeZone;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_platforms::{HourField, system_hour_field};

/// This computer's time zone and hour field, which every time a command prints is written in.
pub(crate) struct LocalClock {
    time_zone: TimeZone,
    hour_field: HourField,
}

impl LocalClock {
    /// Reads this computer's time zone and hour field; fails as either read does.
    pub(crate) fn read() -> anyhow::Result<Self> {
        let time_zone =
            TimeZone::try_system().context("could not read this computer's time zone")?;
        let hour_field =
            system_hour_field().context("could not read how this computer shows times")?;
        Ok(Self {
            time_zone,
            hour_field,
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

    /// `zoned`'s time of day on this computer's clock.
    fn time_of_day(&self, zoned: &Zoned) -> String {
        self.hour_field.time_of_day(zoned.hour(), zoned.minute())
    }
}
