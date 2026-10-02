//! Pure POSIX-to-Win32 kill translator.
//!
//! Maps a [`PtySignal`] to a Win32 action:
//!
//! - `SIGINT` -> `CTRL_C_EVENT` (graceful).
//! - `SIGTERM` -> `CTRL_BREAK_EVENT`, which the caller escalates if the child does not exit.
//! - `SIGKILL` and `SIGHUP` -> tree kill (`taskkill /T /F`), with no console event.
//!
//! The mapping is pure, so it lives in one place and its tests need no Win32 mock.

#![cfg(target_os = "windows")]

use crate::protocol::PtySignal;

/// How to deliver a translated signal on Windows: as a console control event, or straight to
/// `taskkill /T /F /PID <pid>` (see [`crate::tree_kill::taskkill_argv`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowsKillAction {
    /// Send `GenerateConsoleCtrlEvent(event, pid)`. The caller must follow `CTRL_BREAK_EVENT` with
    /// an escalation timer; `CTRL_C_EVENT` is not escalated.
    ConsoleCtrlEvent(ConsoleCtrlEvent),

    /// Skip console events and run `taskkill /T /F /PID <pid>`; used for `SIGKILL` and `SIGHUP`.
    TreeKill,
}

/// Win32 `GenerateConsoleCtrlEvent` event codes: `CTRL_C_EVENT` = 0 and `CTRL_BREAK_EVENT` = 1.
///
/// <https://learn.microsoft.com/en-us/windows/console/generateconsolectrlevent>
///
/// Cast to `u32` at the FFI boundary (the API takes a `DWORD`); a unit test asserts the numeric
/// values, since sending the wrong one turns a graceful interrupt into a hard stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum ConsoleCtrlEvent {
    CtrlC = 0,
    CtrlBreak = 1,
}

impl ConsoleCtrlEvent {
    /// Numeric code for `GenerateConsoleCtrlEvent`'s `dwCtrlEvent` argument; saves `as u32` casts
    /// at FFI sites.
    #[inline]
    #[must_use]
    pub fn as_u32(self) -> u32 {
        self as u32
    }
}

/// Translates a POSIX [`PtySignal`] to its Windows kill action; pure and total over the enum. The
/// caller performs the action.
#[must_use]
pub fn translate(signal: PtySignal) -> WindowsKillAction {
    match signal {
        PtySignal::Sigint => WindowsKillAction::ConsoleCtrlEvent(ConsoleCtrlEvent::CtrlC),
        PtySignal::Sigterm => WindowsKillAction::ConsoleCtrlEvent(ConsoleCtrlEvent::CtrlBreak),
        // Immediate hard stop: skip the console event.
        PtySignal::Sigkill => WindowsKillAction::TreeKill,
        // SIGHUP has no fixed Windows mapping. `node-pty-host.ts` sends it down the SIGTERM path
        // (CTRL_BREAK, then taskkill after 2 s). The sidecar goes straight to tree kill, which is
        // where a child that ignores CTRL_BREAK ends up anyway, and needs no sidecar-side timer. To
        // match the host, change this arm and its row in the tests.
        PtySignal::Sighup => WindowsKillAction::TreeKill,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translates_each_signal_to_its_windows_action() {
        // SIGINT is the graceful CTRL_C; SIGTERM is CTRL_BREAK, which the caller escalates; SIGKILL
        // and SIGHUP skip the console event for a tree kill.
        for (signal, action) in [
            (
                PtySignal::Sigint,
                WindowsKillAction::ConsoleCtrlEvent(ConsoleCtrlEvent::CtrlC),
            ),
            (
                PtySignal::Sigterm,
                WindowsKillAction::ConsoleCtrlEvent(ConsoleCtrlEvent::CtrlBreak),
            ),
            (PtySignal::Sigkill, WindowsKillAction::TreeKill),
            (PtySignal::Sighup, WindowsKillAction::TreeKill),
        ] {
            assert_eq!(translate(signal), action, "{signal:?}");
        }
    }

    #[test]
    fn console_events_carry_the_win32_codes() {
        // Win32 defines CTRL_C_EVENT as 0 and CTRL_BREAK_EVENT as 1.
        assert_eq!(ConsoleCtrlEvent::CtrlC.as_u32(), 0);
        assert_eq!(ConsoleCtrlEvent::CtrlBreak.as_u32(), 1);
    }
}
