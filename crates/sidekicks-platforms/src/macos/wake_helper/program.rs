//! The macOS wake helper's bookings, the root program launchd starts from a property list in
//! `/Library/LaunchDaemons` when a connection reaches its socket: it books a wake from sleep one
//! minute before a time the console user's service asks for, at most eight days ahead, through
//! `IOPMSchedulePowerEvent` with `kIOPMAutoWake`, each wake tagged with the app's identifier, and
//! cancels only a wake it booked, repeating the date, tag and type it booked with. At each start it
//! takes back the wakes it booked before from the system's queue, which keeps them while the
//! helper is not running. The program includes this file by path, beside the socket's message
//! file, so it names nothing else in this crate and links only the power-event calls.

// The program includes this file by path, which resolves a child module beside the file rather
// than in its folder, so the path is spelled out for both builds.
#[path = "program/socket.rs"]
mod socket;

use std::collections::BTreeSet;
use std::time::{Duration, SystemTime};

use objc2_core_foundation::{CFArray, CFDate, CFDictionary, CFRetained, CFString, CFType};
use objc2_io_kit::{
    IOPMCancelScheduledPowerEvent, IOPMCopyScheduledPowerEvents, IOPMSchedulePowerEvent, IOReturn,
    kIOPMAutoWake, kIOPMPowerEventAppNameKey, kIOPMPowerEventTimeKey, kIOPMPowerEventTypeKey,
    kIOReturnSuccess,
};
use sidekicks_contracts::app_identity::APP_BUNDLE_IDENTIFIER;

pub use socket::answer_wake_connection;

// The library re-exports the socket's message types at its root, and the program's root names
// them too, so `crate::` reaches them in both builds.
use crate::{WakeRefusal, WakeReply, WakeRequest};

/// The name the helper's property list gives the one socket launchd holds for it, which the helper
/// asks launchd for at each start.
pub(crate) const WAKE_HELPER_SOCKET_NAME: &str = "Listeners";

// How long before the asked time the machine wakes.
const WAKE_LEAD: Duration = Duration::from_mins(1);

// The furthest ahead an asked time may be.
const MOST_AHEAD: Duration = Duration::from_hours(8 * 24);

// The most wakes the helper keeps booked at once: the service asks for one per account's window,
// and the bound keeps a looping caller from filling the system's power-event queue.
const MOST_WAKES: usize = 64;

/// The system's power-event queue, which books and cancels a wake at a date in whole seconds
/// since 1970.
pub trait PowerEvents {
    /// Books a wake from sleep at `wake_at`; fails with the call's `IOReturn`.
    fn schedule_wake(&mut self, wake_at: i64) -> Result<(), IOReturn>;
    /// Cancels the wake booked at `wake_at`; fails with the call's `IOReturn`.
    fn cancel_wake(&mut self, wake_at: i64) -> Result<(), IOReturn>;
    /// The wakes from sleep the queue holds under this helper's tag, each at its date.
    fn booked_wakes(&self) -> Vec<i64>;
}

/// The wakes this helper booked, kept so a cancel repeats the date it booked with, over the queue
/// it books them on.
pub struct WakeBookings<E> {
    events: E,
    booked: BTreeSet<i64>,
}

impl<E: PowerEvents> WakeBookings<E> {
    /// Keeps the wakes `events` already holds under this helper's tag, as a restart finds those
    /// it booked before, and books on `events`.
    pub fn new(events: E) -> Self {
        let booked = events.booked_wakes().into_iter().collect();
        Self { events, booked }
    }

    /// Answers one request line, `book <seconds>` or `cancel <seconds>` with the asked time in
    /// whole seconds since 1970, at `now`. Wakes already past are forgotten first, since the
    /// system drops a fired event.
    pub fn answer(&mut self, request: &str, now: SystemTime) -> WakeReply {
        let now = seconds_since_1970(now);
        self.booked.retain(|&wake_at| wake_at > now);
        let Ok(request) = request.parse::<WakeRequest>() else {
            return WakeReply::Refused(WakeRefusal::Malformed);
        };
        let (WakeRequest::Book(asked_at) | WakeRequest::Cancel(asked_at)) = request;
        let Some(wake_at) = asked_at.checked_sub(WAKE_LEAD.as_secs().cast_signed()) else {
            return WakeReply::Refused(WakeRefusal::Malformed);
        };
        match request {
            WakeRequest::Book(_) => self.book(now, asked_at, wake_at),
            WakeRequest::Cancel(_) => self.cancel(wake_at),
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

/// Whole seconds since 1970, rounded down, the unit a request names its time in, so a booking and
/// its cancel name the same second; a time before 1970 reads as 0, which a booking refuses as past.
pub(crate) fn seconds_since_1970(time: SystemTime) -> i64 {
    time.duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |since| since.as_secs().cast_signed())
}

/// The system's own power-event queue: each wake is `kIOPMAutoWake`, tagged with the app's bundle
/// identifier. Both calls need root.
pub struct SystemPowerEvents {
    tag: CFRetained<CFString>,
    wake_type: CFRetained<CFString>,
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

    fn booked_wakes(&self) -> Vec<i64> {
        let Some(events) = IOPMCopyScheduledPowerEvents() else {
            return Vec::new();
        };
        // SAFETY: the queue answers an array of dictionaries keyed by strings, one per event.
        let events = unsafe {
            CFRetained::cast_unchecked::<CFArray<CFDictionary<CFString, CFType>>>(events)
        };
        let [name_key, type_key, time_key] = [
            kIOPMPowerEventAppNameKey,
            kIOPMPowerEventTypeKey,
            kIOPMPowerEventTimeKey,
        ]
        .map(|key| CFString::from_str(key.to_str().expect("an event key is ASCII")));
        let read_string = |event: &CFDictionary<CFString, CFType>, key: &CFString| {
            event.get(key)?.downcast::<CFString>().ok()
        };
        events
            .iter()
            .filter(|event| {
                read_string(event, &name_key).is_some_and(|name| *name == *self.tag)
                    && read_string(event, &type_key).is_some_and(|kind| *kind == *self.wake_type)
            })
            .filter_map(|event| {
                let date = event.get(&time_key)?.downcast::<CFDate>().ok()?;
                Some(nearest_second_since_1970(date.to_system_time()?))
            })
            .collect()
    }
}

// The whole seconds since 1970 nearest `time`, since the queue may keep a date to a fraction of a
// second; a time before 1970 reads as 0.
fn nearest_second_since_1970(time: SystemTime) -> i64 {
    time.duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |since| {
            (since.as_secs() + u64::from(since.subsec_nanos() >= 500_000_000)).cast_signed()
        })
}

// The date of a wake in whole seconds since 1970, which is in the future, so the same seconds
// always make the same date.
fn power_event_date(wake_at: i64) -> CFRetained<CFDate> {
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
