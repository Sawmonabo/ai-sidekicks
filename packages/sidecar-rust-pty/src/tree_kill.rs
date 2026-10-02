//! Builder for the `taskkill /T /F /PID <pid>` command line.
//!
//! A single-PID kill on Windows leaves descendant processes orphaned, so the hard-stop teardown
//! runs `taskkill` with `/T` (the whole tree) and `/F` (force). A pure function builds the argv, so
//! its contract (both flags and a decimal PID) is unit-tested without spawning anything.
//!
//! The caller owns spawning and the timeout: reaping must not block the sidecar's main loop, so it
//! runs `taskkill` with a bound and emits `ExitCodeNotification` even if reaping is incomplete.

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

    #[test]
    fn argv_is_the_whole_tree_forced_kill_of_one_decimal_pid() {
        // The whole argv at once: the program, /T and /F, /PID (never /IM, which would also kill
        // peers with the same image name), and the PID in decimal right after /PID.
        assert_eq!(taskkill_argv(0x2A), ["taskkill", "/T", "/F", "/PID", "42"]);
    }
}
