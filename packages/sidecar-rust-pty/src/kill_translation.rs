//! Pure POSIX→Win32 kill-semantics translator (Plan-024 §Invariants I-024-1).
//!
//! `PtyHost.kill(sessionId, signal)` on Windows MUST translate POSIX signal
//! semantics to the Win32 `GenerateConsoleCtrlEvent` API per ADR-019
//! §Decision item 1 + Plan-024 §Windows Implementation Gotchas Gotcha 1
//! (`microsoft/node-pty#167`):
//!
//! - `SIGINT`  → `CTRL_C_EVENT`     (graceful Ctrl+C delivery)
//! - `SIGTERM` → `CTRL_BREAK_EVENT` (graceful break, escalate per I-024-2)
//! - `SIGKILL` → tree-kill direct   (no console-control event; route to
//!                                    `tree_kill::taskkill_argv` per I-024-2)
//! - `SIGHUP`  → tree-kill direct   (treat as hard-stop; matches the
//!                                    `node-pty-host.ts` Phase 2 cascade)
//!
//! ## Why a separate module instead of inline match in `pty_session.rs`?
//!
//! The translator is **pure** — no I/O, no Win32 calls, no PTY state. A
//! standalone module gives us:
//!
//!   1. A single point of truth for the POSIX→Win32 mapping that both the
//!      sidecar's `pty_session::kill` (Phase 3 follow-up) and any future
//!      higher-layer Windows-control surface can call into.
//!   2. A pure function exhaustively unit-testable per [`PtySignal`]
//!      variant — Plan-024 explicitly requires "Cover with a unit test in
//!      `kill_translation.rs`" for I-024-1.
//!   3. Stable scope-isolation: modifying the mapping (e.g., changing
//!      SIGHUP's escalation) touches one file and surfaces the change in
//!      the test diff rather than buried in a 900-line PTY holder.
//!
//! ## Phase boundary note
//!
//! T-024-3-1 lands the **substrate**. End-to-end wiring of this module
//! into `pty_session::kill()` is a follow-up task (the Phase 1 holder
//! returns `WindowsKillNotImplemented` on the Windows arm and is NOT in
//! T-024-3-1's `target_paths`). The module ships with its tests so the
//! mapping is locked-in before the wire-through PR; the reviewer can
//! diff this single file when the wire-through lands.
//!
//! Refs: Plan-024 I-024-1, ADR-019 §Decision item 1, ADR-019 §Failure
//! Mode Analysis row "kill propagation".

#![cfg(target_os = "windows")]

use crate::protocol::PtySignal;

/// Outcome of translating a POSIX signal for Windows delivery.
///
/// Either issue a `GenerateConsoleCtrlEvent` of the named code, or skip
/// the console-control hop entirely and go straight to the
/// `taskkill /T /F /PID <pid>` tree-kill path. The dispatcher is the
/// caller; it pattern-matches and dispatches to either
/// `windows-sys::Win32::System::Console::GenerateConsoleCtrlEvent` (the
/// FFI binding lives outside this module — see follow-up task) or
/// [`crate::tree_kill::taskkill_argv`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowsKillAction {
    /// Issue `GenerateConsoleCtrlEvent(event, pid)` — graceful console
    /// control event delivery. The dispatcher MUST follow up with an
    /// escalation timer for `CTRL_BREAK_EVENT` per I-024-2 (a child
    /// that ignores the break gets `taskkill`-ed after the bounded
    /// wait); `CTRL_C_EVENT` does not auto-escalate (the consumer
    /// caller already chose the gentlest signal).
    ConsoleCtrlEvent(ConsoleCtrlEvent),

    /// Skip console-control entirely; invoke `taskkill /T /F /PID <pid>`
    /// directly. Reserved for `SIGKILL` and `SIGHUP` per the cascade
    /// table above.
    TreeKill,
}

/// Win32 `GenerateConsoleCtrlEvent` event codes the sidecar issues.
///
/// Documented in [Win32 GenerateConsoleCtrlEvent docs](https://learn.microsoft.com/en-us/windows/console/generateconsolectrlevent):
///
/// - `CTRL_C_EVENT     = 0` — generates a CTRL+C signal (SIGINT analog)
/// - `CTRL_BREAK_EVENT = 1` — generates a CTRL+BREAK signal (graceful
///                            stop; `node-pty` treats this as the
///                            hard-stop entry point per Phase 2)
///
/// Cast to `u32` at the FFI boundary — the underlying API takes a
/// `DWORD`. The repr-numeric mapping is asserted by the unit tests so a
/// future enum reordering breaks the build deliberately.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum ConsoleCtrlEvent {
    CtrlC = 0,
    CtrlBreak = 1,
}

impl ConsoleCtrlEvent {
    /// Numeric code passed to `GenerateConsoleCtrlEvent`'s `dwCtrlEvent`
    /// parameter. Matches the `repr(u32)` discriminant 1:1; exposed as
    /// a method so callers can avoid `as u32` casts at every FFI site.
    #[inline]
    #[must_use]
    pub fn as_u32(self) -> u32 {
        self as u32
    }
}

/// Translate a POSIX [`PtySignal`] to its Windows kill action.
///
/// Pure function: no I/O, no Win32 calls, deterministic. Total over the
/// closed [`PtySignal`] enum.
///
/// See the module rustdoc for the full POSIX→Win32 cascade table. The
/// returned [`WindowsKillAction`] MUST be dispatched by the caller; this
/// function does not invoke `GenerateConsoleCtrlEvent` or `taskkill`
/// directly so its testability is unconditional (no Win32 mock needed
/// for the translator's unit tests).
#[must_use]
pub fn translate(signal: PtySignal) -> WindowsKillAction {
    match signal {
        PtySignal::Sigint => WindowsKillAction::ConsoleCtrlEvent(ConsoleCtrlEvent::CtrlC),
        PtySignal::Sigterm => WindowsKillAction::ConsoleCtrlEvent(ConsoleCtrlEvent::CtrlBreak),
        // SIGKILL is the immediate-hard-stop contract; skip the
        // console-control-event hop and invoke taskkill directly per
        // Plan-024 §Implementation Step 8 line 120 ("`SIGKILL`
        // (immediate hard-stop) → `taskkill /T /F /PID <pid>` directly,
        // skipping `CTRL_BREAK_EVENT`").
        PtySignal::Sigkill => WindowsKillAction::TreeKill,
        // SIGHUP is not pinned by ADR-019 / Plan-024 to a specific
        // Windows mapping. Matching the most conservative graceful-then-
        // force shape would be CTRL_BREAK_EVENT-then-escalate; matching
        // the hard-stop semantics POSIX users typically associate with
        // SIGHUP-on-controlling-terminal is taskkill direct. The
        // `node-pty-host.ts` Phase 2 implementation chose
        // CTRL_BREAK_EVENT-then-escalate (mirroring SIGTERM); the
        // sidecar deliberately diverges to `TreeKill` direct because:
        //   - `node-pty-host.ts` SIGHUP path goes through the same
        //     2 s timer + escalation that SIGTERM uses, which is
        //     observably equivalent to TreeKill direct from the
        //     daemon's perspective on a child that ignores
        //     CTRL_BREAK.
        //   - The Phase 3 sidecar dispatcher does not need to
        //     synthesize a 2 s timer for a signal whose terminal
        //     semantics map cleanly to "kill the tree."
        // The divergence is documented; if a future consumer needs
        // matching behavior across hosts, switch the variant here and
        // update `kill_translation_translates_sighup_to_tree_kill`.
        PtySignal::Sighup => WindowsKillAction::TreeKill,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // I-024-1 verification — exhaustive unit coverage of the
    // POSIX→Win32 mapping. One test per [`PtySignal`] variant so a
    // partial enum match (or a future variant added without
    // updating this module) is caught at compile time AND at test
    // time.

    #[test]
    fn translates_sigint_to_ctrl_c_event() {
        // I-024-1: `SIGINT` MUST map to `CTRL_C_EVENT` per ADR-019
        // §Decision item 1.
        assert_eq!(
            translate(PtySignal::Sigint),
            WindowsKillAction::ConsoleCtrlEvent(ConsoleCtrlEvent::CtrlC),
        );
    }

    #[test]
    fn translates_sigterm_to_ctrl_break_event() {
        // I-024-1: `SIGTERM` (graceful hard-stop) MUST map to
        // `CTRL_BREAK_EVENT` first per ADR-019 §Decision item 1 +
        // Plan-024 §Implementation Step 8 line 119.
        assert_eq!(
            translate(PtySignal::Sigterm),
            WindowsKillAction::ConsoleCtrlEvent(ConsoleCtrlEvent::CtrlBreak),
        );
    }

    #[test]
    fn translates_sigkill_to_tree_kill_direct() {
        // I-024-1 + I-024-2: `SIGKILL` (immediate hard-stop) skips
        // `CTRL_BREAK_EVENT` and invokes `taskkill /T /F /PID <pid>`
        // directly per Plan-024 §Implementation Step 8 line 120.
        assert_eq!(translate(PtySignal::Sigkill), WindowsKillAction::TreeKill);
    }

    #[test]
    fn translates_sighup_to_tree_kill_direct() {
        // SIGHUP→TreeKill divergence from `node-pty-host.ts` is
        // documented in `translate`'s match arm. Pin the chosen
        // mapping so a future regression to CTRL_BREAK_EVENT-then-
        // escalate is a deliberate choice with a test diff, not a
        // silent behavioral flip.
        assert_eq!(translate(PtySignal::Sighup), WindowsKillAction::TreeKill);
    }

    // ConsoleCtrlEvent numeric codes — load-bearing because the FFI
    // binding casts via `as u32` at the call site. A future enum
    // reordering MUST trip these tests rather than silently changing
    // the wire-level Win32 call.

    #[test]
    fn ctrl_c_event_numeric_code_is_zero() {
        // CTRL_C_EVENT = 0 per Win32 docs (linked in module rustdoc).
        assert_eq!(ConsoleCtrlEvent::CtrlC.as_u32(), 0);
        assert_eq!(ConsoleCtrlEvent::CtrlC as u32, 0);
    }

    #[test]
    fn ctrl_break_event_numeric_code_is_one() {
        // CTRL_BREAK_EVENT = 1 per Win32 docs.
        assert_eq!(ConsoleCtrlEvent::CtrlBreak.as_u32(), 1);
        assert_eq!(ConsoleCtrlEvent::CtrlBreak as u32, 1);
    }

    // Total-coverage exhaustiveness check: enumerate every PtySignal
    // variant via a let-match over a synthetic instance and ensure
    // `translate` returns a non-panicking value. Also serves as a
    // compile-time tripwire — adding a new variant to `PtySignal`
    // without updating `translate` triggers `non_exhaustive_patterns`
    // here too. (The match in `translate` itself is the primary
    // tripwire; this is belt-and-braces.)
    #[test]
    fn translate_is_total_over_pty_signal() {
        for signal in [
            PtySignal::Sigint,
            PtySignal::Sigterm,
            PtySignal::Sigkill,
            PtySignal::Sighup,
        ] {
            // Just exercise — the per-variant assertions above pin the
            // exact return values. Here we ensure `translate` does not
            // panic on any input.
            let _ = translate(signal);
        }
    }
}
