//! `session_remind`: wakes the calling session later with its own note. Codex's alone: a Claude
//! Code session is not given it, since Claude Code's own `ScheduleWakeup` does the same.

use std::borrow::Cow;
use std::fmt;
use std::str::FromStr;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::driver::session_messages::PERSON_CLOCK_TIME_FORMAT;

use crate::tools::gate::CallbackToolGate;
use crate::tools::session::{ToolDescription, text_field};

/// How `session_remind` is gated: it acts, so the calling session's level decides it.
pub const GATE: CallbackToolGate = CallbackToolGate::Level;

/// What a model reads about `session_remind`.
pub const DESCRIPTION: ToolDescription = ToolDescription {
    name: "session_remind",
    summary: "Wake this session later with a note: you end your turn now and a new turn starts \
              at that time with your note in it.",
    body: "{\"in\": \"20m\", \"note\": \"Check whether CI on PR 512 finished.\"}\n\nUse it \
           instead of waiting when you are blocked on something slow outside the sessions (CI, \
           a deploy).",
};

/// `session_remind`'s arguments.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionRemindArguments {
    /// How long from now the reminder comes due; `in` on the wire.
    #[serde(rename = "in")]
    #[schemars(description = DELAY_WORDS)]
    pub delay: ReminderDelay,
    /// What to do on waking.
    #[schemars(description = text_field("What to do when you wake.", usize::MAX))]
    pub note: FreeFormText<{ usize::MAX }>,
}

/// The words a model reads about a reminder's delay.
const DELAY_WORDS: &str = "How long from now: minutes or hours, such as \"20m\" or \"2h\". A \
                           whole number from 1 to 9999, then m for minutes or h for hours.";

/// A delay's two written forms: a whole number from 1 to 9999, then `m` or `h`.
const DELAY_PATTERN: &str = "^0*[1-9][0-9]{0,3}[mh]$";

/// The most digits a delay's count holds past its leading zeros, so it is at most 9999.
const DELAY_COUNT_MAX_DIGITS: usize = 4;

/// How long from now a reminder comes due, in whole minutes, at least 1 and at most 9999 hours;
/// written `20m` or `2h` on the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ReminderDelay {
    /// The delay in minutes, at least 1 and at most 9999 hours.
    minutes: u32,
}

impl ReminderDelay {
    /// The delay in whole minutes, at least 1.
    pub fn minutes(self) -> u32 {
        self.minutes
    }
}

/// Why a text is not a reminder's delay.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error(
    "a delay is a whole number from 1 to 9999, then m for minutes or h for hours, such as 20m or \
     2h"
)]
pub struct ReminderDelayError;

impl FromStr for ReminderDelay {
    type Err = ReminderDelayError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        let (count, minutes_per_unit) = if let Some(count) = text.strip_suffix('m') {
            (count, 1)
        } else if let Some(count) = text.strip_suffix('h') {
            (count, 60)
        } else {
            return Err(ReminderDelayError);
        };
        let significant = count.trim_start_matches('0');
        if significant.is_empty()
            || significant.len() > DELAY_COUNT_MAX_DIGITS
            || !significant.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(ReminderDelayError);
        }
        // At most four digits, so the count and its minutes fit.
        let count = significant
            .bytes()
            .fold(0_u32, |count, digit| count * 10 + u32::from(digit - b'0'));
        Ok(Self {
            minutes: count * minutes_per_unit,
        })
    }
}

impl fmt::Display for ReminderDelay {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.minutes.is_multiple_of(60) {
            write!(formatter, "{}h", self.minutes / 60)
        } else {
            write!(formatter, "{}m", self.minutes)
        }
    }
}

impl Serialize for ReminderDelay {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for ReminderDelay {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        String::deserialize(deserializer)?
            .parse()
            .map_err(D::Error::custom)
    }
}

impl JsonSchema for ReminderDelay {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "ReminderDelay".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "description": DELAY_WORDS,
            "type": "string",
            "pattern": DELAY_PATTERN,
        })
    }
}

/// The reminder set, at the time it comes due on the person's clock.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionRemindResult {
    /// When the reminder comes due.
    pub at: jiff::Zoned,
}

impl fmt::Display for SessionRemindResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "Reminder set for {}. End your turn now.",
            self.at.strftime(PERSON_CLOCK_TIME_FORMAT)
        )
    }
}
