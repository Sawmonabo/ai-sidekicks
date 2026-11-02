//! The one line each way on the wake helper's socket: the request, `book <seconds>` or
//! `cancel <seconds>` with the asked time in whole seconds since 1970, and the reply, `booked`,
//! `canceled`, `refused <word>` or `failed <IOReturn>`. The service writes requests and reads
//! replies with these types, and the helper program, which includes this file by path, reads
//! requests and writes replies with them, so the words live here alone.

use std::fmt;
use std::str::FromStr;

/// One request to the wake helper, each naming the asked time in whole seconds since 1970.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WakeRequest {
    /// Book a wake one minute before the asked time.
    Book(i64),
    /// Cancel the wake booked for the asked time.
    Cancel(i64),
}

/// What the helper answers a request with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WakeReply {
    /// The wake is booked, now or by an earlier request for the same time.
    Booked,
    /// The booked wake is canceled.
    Canceled,
    /// The request is refused before any power-event call.
    Refused(WakeRefusal),
    /// The power-event call failed with this `IOReturn`.
    Failed(i32),
}

/// Why the helper refuses a request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WakeRefusal {
    /// The connecting process does not run as the user at the Mac's screen, or no one is there.
    NotConsoleUser,
    /// The wake, one minute before the asked time, would not be in the future.
    NotAhead,
    /// The asked time is more than eight days ahead.
    BeyondEightDays,
    /// The cancel names no wake this helper booked.
    NotBooked,
    /// The helper already keeps its most wakes booked.
    TooManyWakes,
    /// The request is not `book <seconds>` or `cancel <seconds>`.
    Malformed,
}

/// A line that is no request or no reply the helper's socket carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("the line is not a wake helper message")]
pub struct UnknownWakeMessage;

impl fmt::Display for WakeRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Book(asked_at) => write!(formatter, "book {asked_at}"),
            Self::Cancel(asked_at) => write!(formatter, "cancel {asked_at}"),
        }
    }
}

impl FromStr for WakeRequest {
    type Err = UnknownWakeMessage;

    /// Reads `book <seconds>` or `cancel <seconds>`, a line ending allowed, the seconds digits
    /// alone.
    fn from_str(line: &str) -> Result<Self, Self::Err> {
        let (verb, asked_at) = line
            .trim_end_matches(['\r', '\n'])
            .split_once(' ')
            .ok_or(UnknownWakeMessage)?;
        if asked_at.is_empty() || !asked_at.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(UnknownWakeMessage);
        }
        let asked_at = asked_at.parse().map_err(|_overflow| UnknownWakeMessage)?;
        match verb {
            "book" => Ok(Self::Book(asked_at)),
            "cancel" => Ok(Self::Cancel(asked_at)),
            _ => Err(UnknownWakeMessage),
        }
    }
}

impl fmt::Display for WakeReply {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Booked => formatter.write_str("booked"),
            Self::Canceled => formatter.write_str("canceled"),
            Self::Refused(refusal) => write!(formatter, "refused {}", refusal.wire_word()),
            Self::Failed(code) => write!(formatter, "failed {code:#010x}"),
        }
    }
}

impl FromStr for WakeReply {
    type Err = UnknownWakeMessage;

    /// Reads a reply line as [`fmt::Display`] writes it, a line ending allowed; the `IOReturn` is
    /// the eight hex digits after `0x`, read as the 32 bits the call returned.
    fn from_str(line: &str) -> Result<Self, Self::Err> {
        let line = line.trim_end_matches(['\r', '\n']);
        match line.split_once(' ') {
            None if line == "booked" => Ok(Self::Booked),
            None if line == "canceled" => Ok(Self::Canceled),
            Some(("refused", word)) => WakeRefusal::ALL
                .into_iter()
                .find(|refusal| refusal.wire_word() == word)
                .map(Self::Refused)
                .ok_or(UnknownWakeMessage),
            Some(("failed", code)) => {
                let digits = code.strip_prefix("0x").ok_or(UnknownWakeMessage)?;
                if digits.len() != 8 {
                    return Err(UnknownWakeMessage);
                }
                let bits =
                    u32::from_str_radix(digits, 16).map_err(|_bad_digit| UnknownWakeMessage)?;
                Ok(Self::Failed(bits.cast_signed()))
            }
            _ => Err(UnknownWakeMessage),
        }
    }
}

impl WakeRefusal {
    // Every refusal, so a reply's word is read back by the same words it is written with.
    const ALL: [Self; 6] = [
        Self::NotConsoleUser,
        Self::NotAhead,
        Self::BeyondEightDays,
        Self::NotBooked,
        Self::TooManyWakes,
        Self::Malformed,
    ];

    fn wire_word(self) -> &'static str {
        match self {
            Self::NotConsoleUser => "notConsoleUser",
            Self::NotAhead => "notAhead",
            Self::BeyondEightDays => "beyondEightDays",
            Self::NotBooked => "notBooked",
            Self::TooManyWakes => "tooManyWakes",
            Self::Malformed => "malformed",
        }
    }
}
