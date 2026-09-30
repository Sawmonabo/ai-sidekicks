//! Builder for the `taskkill /T /F /PID <pid>` command line.
//!
//! A single-PID kill on Windows leaves descendant processes orphaned, so the hard-stop teardown
//! runs `taskkill` with `/T` (the whole tree) and `/F` (force). A pure function builds the argv, so
//! its contract (both flags and a decimal PID) is unit-tested without spawning anything.
//!
//! The caller owns spawning and the timeout: reaping must not block the sidecar's main loop, so it
//! runs `taskkill` with a bound and emits `ExitCodeNotification` even if reaping is incomplete. The
//! Windows kill path in `pty_session` does not call this yet.

#![cfg(target_os = "windows")]

/// Builds the argv `["taskkill", "/T", "/F", "/PID", "<pid>"]`.
///
/// The caller may replace the first element with the full `taskkill.exe` path to avoid PATH
/// poisoning. The PID is rendered in decimal, the only form `taskkill.exe` accepts. Owned `String`s
/// let the caller pass the argv to `Command::args` without managing lifetimes.
#[must_use]
pub fn taskkill_argv(pid: u32) -> Vec<String> {
    vec![
        // Resolved via PATH unless the caller substitutes the full path.
        "taskkill".to_string(),
        // /T also terminates child processes; a single-PID kill leaves orphans on Windows.
        "/T".to_string(),
        // /F forces termination; PTY children rarely have a message loop to honor a graceful close.
        "/F".to_string(),
        // /PID scopes the kill to one process; /IM would also kill peers with the same image name.
        "/PID".to_string(),
        // Decimal only: `taskkill.exe` rejects hex.
        pid.to_string(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    // The argv must contain /T and /F, select by PID, and render the PID in decimal.

    #[test]
    fn argv_invokes_taskkill_program() {
        // A different program (`wmic`, `pskill`) would bypass Windows' own tree walk.
        let argv = taskkill_argv(12345);
        assert_eq!(argv[0], "taskkill");
    }

    #[test]
    fn argv_includes_tree_flag() {
        // Without /T grandchildren are orphaned.
        let argv = taskkill_argv(12345);
        assert!(
            argv.iter().any(|s| s == "/T"),
            "argv missing /T flag (descendant-tree termination): {argv:?}"
        );
    }

    #[test]
    fn argv_includes_force_flag() {
        // Without /F, processes with no message loop survive.
        let argv = taskkill_argv(12345);
        assert!(
            argv.iter().any(|s| s == "/F"),
            "argv missing /F flag (forceful termination): {argv:?}"
        );
    }

    #[test]
    fn argv_selects_by_pid_not_image_name() {
        // /IM would kill unrelated peers with the same image name.
        let argv = taskkill_argv(12345);
        assert!(
            argv.iter().any(|s| s == "/PID"),
            "argv missing /PID selector: {argv:?}"
        );
        assert!(
            !argv.iter().any(|s| s == "/IM"),
            "argv must not use /IM (image-name selector would kill peers): {argv:?}"
        );
    }

    #[test]
    fn argv_renders_pid_as_decimal() {
        // taskkill.exe parses decimal only.
        let argv = taskkill_argv(0x2A);
        assert!(
            argv.iter().any(|s| s == "42"),
            "argv missing decimal-rendered PID '42' for input 0x2A: {argv:?}"
        );
    }

    #[test]
    fn argv_renders_zero_pid() {
        // The builder is total over u32; the caller must not pass 0.
        let argv = taskkill_argv(0);
        assert!(argv.iter().any(|s| s == "0"));
    }

    #[test]
    fn argv_renders_max_pid() {
        // Total over u32; real PIDs are far smaller.
        let argv = taskkill_argv(u32::MAX);
        assert!(argv.iter().any(|s| s == &u32::MAX.to_string()));
    }

    #[test]
    fn argv_has_exactly_five_slots() {
        // Pin the argv length so a future addition (e.g., a `/FI`
        // Pins the length so a new clause is a deliberate change: [program, /T, /F, /PID, <pid>].
        let argv = taskkill_argv(12345);
        assert_eq!(
            argv.len(),
            5,
            "argv length is a contract surface; \
             additions need a deliberate test update: {argv:?}"
        );
    }

    #[test]
    fn argv_pid_is_last_argument() {
        // The PID must directly follow /PID.
        let argv = taskkill_argv(12345);
        let pid_flag_idx = argv
            .iter()
            .position(|s| s == "/PID")
            .expect("/PID flag present");
        assert_eq!(
            argv[pid_flag_idx + 1],
            "12345",
            "PID value MUST follow /PID flag immediately: {argv:?}"
        );
    }
}
