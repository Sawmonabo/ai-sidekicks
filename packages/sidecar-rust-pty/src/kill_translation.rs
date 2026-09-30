//! Pure POSIX-to-Win32 kill translator.
//!
//! Maps a [`PtySignal`] to a Win32 action:
//!
//! - `SIGINT` -> `CTRL_C_EVENT` (graceful).
//! - `SIGTERM` -> `CTRL_BREAK_EVENT`, which the caller escalates if the child does not exit.
//! - `SIGKILL` and `SIGHUP` -> tree kill (`taskkill /T /F`), with no console event.
//!
//! The mapping is pure, so it lives in one place and its tests need no Win32 mock. The Windows kill
//! path in `pty_session` does not call it yet.

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
/// Cast to `u32` at the FFI boundary (the API takes a `DWORD`); the unit tests assert the numeric
/// values so a reorder breaks the build.
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
        // match the host, change this arm and `translates_sighup_to_tree_kill_direct`.
        PtySignal::Sighup => WindowsKillAction::TreeKill,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // One test per `PtySignal` variant.

    #[test]
    fn translates_sigint_to_ctrl_c_event() {
        assert_eq!(
            translate(PtySignal::Sigint),
            WindowsKillAction::ConsoleCtrlEvent(ConsoleCtrlEvent::CtrlC),
        );
    }

    #[test]
    fn translates_sigterm_to_ctrl_break_event() {
        assert_eq!(
            translate(PtySignal::Sigterm),
            WindowsKillAction::ConsoleCtrlEvent(ConsoleCtrlEvent::CtrlBreak),
        );
    }

    #[test]
    fn translates_sigkill_to_tree_kill_direct() {
        assert_eq!(translate(PtySignal::Sigkill), WindowsKillAction::TreeKill);
    }

    #[test]
    fn translates_sighup_to_tree_kill_direct() {
        // Pins the SIGHUP choice documented in `translate`, so a change to CTRL_BREAK-then-escalate
        // is deliberate.
        assert_eq!(translate(PtySignal::Sighup), WindowsKillAction::TreeKill);
    }

    // The FFI binding casts these with `as u32`, so a reorder must fail a test.

    #[test]
    fn ctrl_c_event_numeric_code_is_zero() {
        // Win32 defines CTRL_C_EVENT as 0.
        assert_eq!(ConsoleCtrlEvent::CtrlC.as_u32(), 0);
        assert_eq!(ConsoleCtrlEvent::CtrlC as u32, 0);
    }

    #[test]
    fn ctrl_break_event_numeric_code_is_one() {
        // Win32 defines CTRL_BREAK_EVENT as 1.
        assert_eq!(ConsoleCtrlEvent::CtrlBreak.as_u32(), 1);
        assert_eq!(ConsoleCtrlEvent::CtrlBreak as u32, 1);
    }

    // Exercises every variant; the exhaustive match in `translate` is what fails the build on a new
    // one.
    #[test]
    fn translate_is_total_over_pty_signal() {
        for signal in [
            PtySignal::Sigint,
            PtySignal::Sigterm,
            PtySignal::Sigkill,
            PtySignal::Sighup,
        ] {
            let _ = translate(signal);
        }
    }
}
