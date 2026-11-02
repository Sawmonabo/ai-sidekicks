//! What every message text between sessions shares, whichever driver or tool writes it.

/// How a session message writes a time: on the person's clock, 12-hour, as `3:42 PM`; a
/// `jiff` `strftime` format.
pub const PERSON_CLOCK_TIME_FORMAT: &str = "%-I:%M %p";
