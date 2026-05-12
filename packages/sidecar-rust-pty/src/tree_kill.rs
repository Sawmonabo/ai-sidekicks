//! `taskkill /T /F /PID <pid>` invocation builder (Plan-024 §Invariants I-024-2).
//!
//! Plan-024 §Windows Implementation Gotchas Gotcha 2
//! (`microsoft/node-pty#437`): a single-PID kill on Windows leaves
//! descendant processes orphaned. The hard-stop teardown MUST invoke
//! `taskkill /T /F /PID <root-pid>` so the entire descendant tree
//! terminates. The `/T` flag walks the tree (load-bearing piece for
//! I-024-2); `/F` forces termination of processes that ignore graceful
//! signals.
//!
//! ## Why an argv builder, not a `Command::new("taskkill").spawn()`?
//!
//! Building the argument vector is **pure** — no I/O, no Win32 calls,
//! no process spawning. Pure functions are exhaustively unit-testable
//! without a mock; they encode the I-024-2 contract (`/T` + `/F` + the
//! exact PID-string format) at the type system rather than burying it
//! inside a `tokio::process::Command::spawn` call buried in the
//! dispatcher.
//!
//! The dispatcher composes [`taskkill_argv`] with
//! `tokio::process::Command` (or the equivalent Windows process-spawn
//! primitive) at the wire-through PR (T-024-3-1 follow-up — see
//! `kill_translation.rs` module rustdoc for the same Phase-boundary
//! note); this module ships the substrate now so the I-024-2
//! contract — `/T` flag + `/F` flag + correct PID stringification — is
//! locked in before the wire-through.
//!
//! ## Wall-clock bounding
//!
//! Plan-024 I-024-2 requires that reaping MUST NOT block the sidecar's
//! main loop — invoke `taskkill` with a timeout and emit
//! `ExitCodeNotification` even if reaping is incomplete. The timeout
//! lives at the dispatcher (the consumer of this argv builder); this
//! module owns only the argv shape. Centralizing the timeout in the
//! dispatcher matches the pattern in `node-pty-host.ts::invokeTaskkill`
//! (the Phase 2 sibling): the argv builder and the wall-clock fence
//! are different concerns and stay separable.
//!
//! Refs: Plan-024 I-024-2, ADR-019 §Decision item 1, ADR-019 §Failure
//! Mode Analysis row "kill propagation", `microsoft/node-pty#437`.

#![cfg(target_os = "windows")]

/// Build the argv for `taskkill /T /F /PID <pid>`.
///
/// Returns the four-element argv ready to hand to a process-spawn
/// primitive (`tokio::process::Command::args`,
/// `std::process::Command::args`, etc). The first element is `taskkill`
/// itself; the dispatcher uses it as the `program` argument or
/// (preferably) prepends the resolved `taskkill.exe` path to defeat
/// PATH-poisoning attacks.
///
/// `/T` is the descendant-tree flag (load-bearing for I-024-2); `/F`
/// forces termination of processes that ignore graceful signals. The
/// PID is rendered as decimal with `to_string()` — Windows accepts
/// decimal PIDs and `taskkill.exe` parses them with no leading-zero or
/// hex affordance.
///
/// # Why return owned `String`s?
///
/// The dispatcher passes the argv to `tokio::process::Command::args(&[…])`,
/// which accepts `AsRef<OsStr>` — owned `String` satisfies this (Strings
/// implement `AsRef<OsStr>`) without forcing the caller to manage
/// lifetimes for the formatted PID string. The four-element vector is
/// constructed once per kill invocation (cold path), so the allocation
/// cost is negligible.
#[must_use]
pub fn taskkill_argv(pid: u32) -> Vec<String> {
    vec![
        // The program name. Resolved via PATH unless the dispatcher
        // upgrades to the full `C:\Windows\System32\taskkill.exe` path
        // (recommended for production). Tests assert on this slot to
        // catch a future regression that swaps to a different
        // tree-kill primitive (e.g., `wmic`).
        "taskkill".to_string(),
        // /T — terminate the named process AND any child processes
        // started by it. This is the I-024-2 load-bearing piece —
        // single-PID kill leaves orphans on Windows per
        // `microsoft/node-pty#437`. Documented in `taskkill /?`:
        //   "Specifies to terminate the specified process and any
        //    child processes which were started by it."
        "/T".to_string(),
        // /F — forcefully terminate processes. Required because
        // graceful termination requires the target process to honor
        // a window-message-loop; PTY children rarely have one. Per
        // `taskkill /?`:
        //   "Specifies to forcefully terminate the process(es)."
        "/F".to_string(),
        // /PID — select target by process id (vs /IM image-name).
        // The PID-by-id path is the only way to scope termination to
        // a specific child; image-name would over-kill peers in the
        // same process group.
        "/PID".to_string(),
        // Decimal PID. `taskkill.exe` accepts decimal PIDs only —
        // hex (e.g., `0x2A`) is rejected with an "invalid argument"
        // error. `u32::to_string()` always produces decimal.
        pid.to_string(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    // I-024-2 verification — the argv MUST contain `/T` and `/F`,
    // MUST select by PID, and MUST render the PID in decimal. These
    // unit tests pin every load-bearing argv slot so a future
    // regression (omitting /T, swapping to /IM, hex-encoding the
    // PID) trips the build.

    #[test]
    fn argv_invokes_taskkill_program() {
        // The dispatcher uses argv[0] as the program name. A future
        // regression to `wmic` or `pskill` would silently bypass
        // Windows's first-party tree-walk implementation.
        let argv = taskkill_argv(12345);
        assert_eq!(argv[0], "taskkill");
    }

    #[test]
    fn argv_includes_tree_flag() {
        // I-024-2: `/T` MUST be present so the descendant tree is
        // walked. Without it Windows orphans every grandchild, the
        // exact failure `microsoft/node-pty#437` documents.
        let argv = taskkill_argv(12345);
        assert!(
            argv.iter().any(|s| s == "/T"),
            "argv missing /T flag (descendant-tree termination): {argv:?}"
        );
    }

    #[test]
    fn argv_includes_force_flag() {
        // I-024-2: `/F` MUST be present so processes that ignore
        // graceful signals (no message loop) are still terminated.
        let argv = taskkill_argv(12345);
        assert!(
            argv.iter().any(|s| s == "/F"),
            "argv missing /F flag (forceful termination): {argv:?}"
        );
    }

    #[test]
    fn argv_selects_by_pid_not_image_name() {
        // /PID is required to scope termination to a single tree.
        // /IM would over-kill peers sharing the same image name,
        // which would crash unrelated daemon-spawned children.
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
        // taskkill.exe parses PIDs as decimal only; a future
        // refactor to `format!("0x{:X}", pid)` would silently break
        // every kill invocation with an "invalid argument" error.
        let argv = taskkill_argv(0x2A);
        assert!(
            argv.iter().any(|s| s == "42"),
            "argv missing decimal-rendered PID '42' for input 0x2A: {argv:?}"
        );
    }

    #[test]
    fn argv_renders_zero_pid() {
        // PID 0 is the System Idle Process — never a valid target,
        // but the argv builder MUST NOT special-case it (the caller
        // is responsible for not passing 0). This test just ensures
        // the builder is total over u32.
        let argv = taskkill_argv(0);
        assert!(argv.iter().any(|s| s == "0"));
    }

    #[test]
    fn argv_renders_max_pid() {
        // u32::MAX exceeds Windows's actual PID range (PIDs are
        // word-sized on Win32, capped well below 2^32 in practice),
        // but again the builder MUST be total over u32 — the caller
        // is responsible for passing valid PIDs.
        let argv = taskkill_argv(u32::MAX);
        assert!(argv.iter().any(|s| s == &u32::MAX.to_string()));
    }

    #[test]
    fn argv_has_exactly_five_slots() {
        // Pin the argv length so a future addition (e.g., a `/FI`
        // filter clause) is a deliberate change with a visible test
        // diff. Five slots: [program, /T, /F, /PID, <pid>].
        let argv = taskkill_argv(12345);
        assert_eq!(
            argv.len(),
            5,
            "argv length is the I-024-2 contract surface; \
             additions need a deliberate test update: {argv:?}"
        );
    }

    #[test]
    fn argv_pid_is_last_argument() {
        // /PID's value MUST immediately follow the /PID flag. A
        // future refactor that reorders the argv (e.g., putting /T
        // last) MUST keep the PID adjacent to its flag.
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
