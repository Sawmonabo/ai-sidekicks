//! The macOS wake helper, a root program launchd runs from a property list in
//! `/Library/LaunchDaemons`: it books a wake from sleep one minute before a time the console user's
//! service asks for, at most eight days ahead, through `IOPMSchedulePowerEvent` with
//! `kIOPMAutoWake`, each wake tagged with the app's identifier, and cancels only a wake it booked,
//! repeating the date, tag and type it booked with. The program includes this file by path, so it
//! names nothing else in this crate and links only the power-event calls.

// The program includes this file by path, which resolves a child module beside the file rather
// than in its folder, so the path is spelled out for both builds.
#[path = "wake_helper/socket.rs"]
mod socket;

use std::collections::BTreeSet;
use std::fmt;
use std::io;
use std::time::{Duration, SystemTime};

use objc2_core_foundation::{CFDate, CFString};
use objc2_io_kit::{
    IOPMCancelScheduledPowerEvent, IOPMSchedulePowerEvent, IOReturn, kIOPMAutoWake,
    kIOReturnSuccess,
};
use sidekicks_contracts::app_identity::APP_BUNDLE_IDENTIFIER;

pub use socket::answer_wake_connection;

/// The socket the helper serves, in a folder only root can write; the console user's service
/// connects to it.
pub const WAKE_HELPER_SOCKET_PATH: &str =
    "/var/run/io.github.sawmonabo.ai-sidekicks.wake-helper/wake.sock";

// How long before the asked time the machine wakes.
const WAKE_LEAD: Duration = Duration::from_mins(1);

// The furthest ahead an asked time may be.
const MOST_AHEAD: Duration = Duration::from_hours(8 * 24);

// The most wakes the helper keeps booked at once: the service asks for one per account's window,
// and the bound keeps a looping caller from filling the system's power-event queue.
const MOST_WAKES: usize = 64;

/// What the helper answers a request with, one line on the socket.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WakeReply {
    /// The wake is booked, now or by an earlier request for the same time.
    Booked,
    /// The booked wake is canceled.
    Canceled,
    /// The request is refused before any power-event call.
    Refused(WakeRefusal),
    /// The power-event call failed with this `IOReturn`.
    Failed(IOReturn),
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

impl WakeRefusal {
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

/// The system's power-event queue, which books and cancels a wake at a date in whole seconds
/// since 1970.
pub trait PowerEvents {
    /// Books a wake from sleep at `wake_at`; fails with the call's `IOReturn`.
    fn schedule_wake(&mut self, wake_at: i64) -> Result<(), IOReturn>;
    /// Cancels the wake booked at `wake_at`; fails with the call's `IOReturn`.
    fn cancel_wake(&mut self, wake_at: i64) -> Result<(), IOReturn>;
}

/// The wakes this helper booked, kept so a cancel repeats the date it booked with, over the queue
/// it books them on.
pub struct WakeBookings<E> {
    events: E,
    booked: BTreeSet<i64>,
}

impl<E: PowerEvents> WakeBookings<E> {
    /// Keeps no wake yet, booking on `events`.
    pub fn new(events: E) -> Self {
        Self {
            events,
            booked: BTreeSet::new(),
        }
    }

    /// Answers one request line, `book <seconds>` or `cancel <seconds>` with the asked time in
    /// whole seconds since 1970, at `now`. Wakes already past are forgotten first, since the
    /// system drops a fired event.
    pub fn answer(&mut self, request: &str, now: SystemTime) -> WakeReply {
        let now = seconds_since_1970(now);
        self.booked.retain(|&wake_at| wake_at > now);
        let Some((is_booking, asked_at)) = parse_request(request) else {
            return WakeReply::Refused(WakeRefusal::Malformed);
        };
        let Some(wake_at) = asked_at.checked_sub(WAKE_LEAD.as_secs().cast_signed()) else {
            return WakeReply::Refused(WakeRefusal::Malformed);
        };
        if is_booking {
            self.book(now, asked_at, wake_at)
        } else {
            self.cancel(wake_at)
        }
    }

    fn book(&mut self, now: i64, asked_at: i64, wake_at: i64) -> WakeReply {
        if wake_at <= now {
            return WakeReply::Refused(WakeRefusal::NotAhead);
        }
        if asked_at - now > MOST_AHEAD.as_secs().cast_signed() {
            return WakeReply::Refused(WakeRefusal::BeyondEightDays);
        }
        if self.booked.contains(&wake_at) {
            return WakeReply::Booked;
        }
        if self.booked.len() >= MOST_WAKES {
            return WakeReply::Refused(WakeRefusal::TooManyWakes);
        }
        match self.events.schedule_wake(wake_at) {
            Ok(()) => {
                self.booked.insert(wake_at);
                WakeReply::Booked
            }
            Err(code) => WakeReply::Failed(code),
        }
    }

    fn cancel(&mut self, wake_at: i64) -> WakeReply {
        if !self.booked.contains(&wake_at) {
            return WakeReply::Refused(WakeRefusal::NotBooked);
        }
        match self.events.cancel_wake(wake_at) {
            Ok(()) => {
                self.booked.remove(&wake_at);
                WakeReply::Canceled
            }
            Err(code) => WakeReply::Failed(code),
        }
    }
}

// The request's verb, true for a booking, and its asked time; `None` for any other line.
fn parse_request(request: &str) -> Option<(bool, i64)> {
    let (verb, asked_at) = request.trim_end_matches(['\r', '\n']).split_once(' ')?;
    let is_booking = match verb {
        "book" => true,
        "cancel" => false,
        _ => return None,
    };
    if !asked_at.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some((is_booking, asked_at.parse().ok()?))
}

// Whole seconds since 1970, rounded down; a time before 1970 reads as 0.
fn seconds_since_1970(time: SystemTime) -> i64 {
    time.duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |since| since.as_secs().cast_signed())
}

/// The system's own power-event queue: each wake is `kIOPMAutoWake`, tagged with the app's bundle
/// identifier. Both calls need root.
pub struct SystemPowerEvents {
    tag: objc2_core_foundation::CFRetained<CFString>,
    wake_type: objc2_core_foundation::CFRetained<CFString>,
}

impl SystemPowerEvents {
    /// The queue, its tag and wake type made once.
    pub fn new() -> Self {
        let wake_type = kIOPMAutoWake
            .to_str()
            .expect("the wake type's name is ASCII");
        Self {
            tag: CFString::from_str(APP_BUNDLE_IDENTIFIER),
            wake_type: CFString::from_str(wake_type),
        }
    }
}

impl Default for SystemPowerEvents {
    fn default() -> Self {
        Self::new()
    }
}

impl PowerEvents for SystemPowerEvents {
    fn schedule_wake(&mut self, wake_at: i64) -> Result<(), IOReturn> {
        let date = power_event_date(wake_at);
        // SAFETY: the date, tag and type are live CoreFoundation objects for the call.
        let status =
            unsafe { IOPMSchedulePowerEvent(Some(&date), Some(&self.tag), Some(&self.wake_type)) };
        returned(status)
    }

    fn cancel_wake(&mut self, wake_at: i64) -> Result<(), IOReturn> {
        let date = power_event_date(wake_at);
        // SAFETY: the date, tag and type are live CoreFoundation objects for the call.
        let status = unsafe {
            IOPMCancelScheduledPowerEvent(Some(&date), Some(&self.tag), Some(&self.wake_type))
        };
        returned(status)
    }
}

// The date of a wake in whole seconds since 1970, which is in the future, so the same seconds
// always make the same date.
fn power_event_date(wake_at: i64) -> objc2_core_foundation::CFRetained<CFDate> {
    let since_1970 = Duration::from_secs(wake_at.unsigned_abs());
    CFDate::from_system_time(&(SystemTime::UNIX_EPOCH + since_1970))
}

fn returned(status: IOReturn) -> Result<(), IOReturn> {
    if status == kIOReturnSuccess {
        Ok(())
    } else {
        Err(status)
    }
}

/// The helper program's whole run: makes the socket's root-only folder, binds the socket for the
/// console user to reach, and answers one connection at a time, forever. Fails when the folder or
/// the socket cannot be set up.
pub fn serve_wake_helper() -> io::Result<()> {
    let listener = socket::bind_wake_socket(std::path::Path::new(WAKE_HELPER_SOCKET_PATH))?;
    let mut bookings = WakeBookings::new(SystemPowerEvents::new());
    socket::serve_wake_connections(&listener, &mut bookings)
}
