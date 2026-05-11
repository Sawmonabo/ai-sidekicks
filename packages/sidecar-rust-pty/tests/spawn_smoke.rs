//! Plan-024 Phase 1 acceptance smoke tests — spawn-only, both platforms.
//!
//! Pins the Phase 1 acceptance criterion verbatim from
//! `docs/plans/024-rust-pty-sidecar.md` §Test And Verification Plan and
//! the audit row at Plan-024:282:
//!
//! > "spawns `sh -c 'echo hello; exit 0'` on Linux/macOS **and**
//! > `cmd.exe /c "echo hello"` on Windows; asserts stdout chunk is
//! > delivered and exit-code propagates"
//!
//! The broader `tests/pty_session.rs` suite (T-024-1-4) covers
//! [`PtySessionRegistry`] behavior in depth (seq monotonicity, kill paths,
//! resize, write round-trip, race-closing). This file is intentionally
//! narrow — one spawn shape per platform, both legs asserted (stdout
//! delivery + exit-code propagation), so a future reader bisecting "did
//! the spawn smoke regress?" reaches a single load-bearing test per
//! platform without sifting through peer cases.
//!
//! ## Platform scope — spawn is platform-agnostic, kill is not
//!
//! Phase 1 pins BOTH Linux/macOS and Windows spawn shapes per the audit
//! row. The platform gating in this file is at the per-test attribute
//! level (`#[cfg(unix)]` / `#[cfg(windows)]`), NOT a module-level
//! `#![cfg(unix)]` — because the surfaces this file actually exercises
//! (`PtySessionRegistry::spawn`, the reader pump, the waiter task,
//! `Envelope::DataFrame`, `Envelope::ExitCodeNotification`) are all
//! platform-agnostic in `src/pty_session.rs`. Only `kill()` has
//! `cfg(unix)` / `cfg(windows)` arms, and this file deliberately spawns
//! children that exit naturally via `exit 0` (unix) or `cmd.exe /c
//! "echo hello"` (Windows; `cmd.exe /c` returns the command's exit
//! code), so `kill()` is never invoked.
//!
//! The Phase 3 carve-out (Plan-024 §Invariants I-024-1 + I-024-2 →
//! T-024-3-1) lands the Windows `KillRequest` translation
//! (`SIGINT`→`CTRL_C_EVENT`, `SIGTERM`→`CTRL_BREAK_EVENT`+`taskkill /T
//! /F`, etc.). That work does NOT relate to spawn smoke — it does not
//! gate this test on Windows.
//!
//! ## Spawn shape rationale
//!
//! [`PtySessionRegistry::spawn`] calls `env_clear()` on the
//! [`portable_pty::CommandBuilder`] before applying the request's `env`
//! pairs (deliberate hermetic-spawn design at `pty_session.rs:421`).
//! With `PATH` empty in the child, bare command names cannot be resolved
//! — so on both platforms we pass an absolute binary path:
//!
//! - Unix: `/bin/sh` (canonical absolute path on Linux + macOS; matches
//!   the convention `tests/pty_session.rs` already uses).
//! - Windows: `C:\Windows\System32\cmd.exe` (canonical absolute path on
//!   every supported Windows build; `%WINDIR%` would require env
//!   propagation that `env_clear()` removes).
//!
//! Working directories are correspondingly absolute (`/tmp` on unix,
//! `C:\` on Windows) so the spawn does not depend on whatever path the
//! parent test runner inherited.
//!
//! Plan-024 Phase 1 / T-024-1-5.

use std::time::Duration;

use sidecar_rust_pty::protocol::{DataStream, Envelope, SpawnRequest};
use sidecar_rust_pty::pty_session::PtySessionRegistry;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::time::timeout;

/// Two-second budget for the smoke scenarios. `echo hello; exit 0`
/// (unix) and `cmd.exe /c "echo hello"` (Windows) both finish in
/// single-digit milliseconds even under CI load; 2 s is two orders of
/// magnitude of headroom while still failing fast on a genuinely hung
/// holder. Matches the budget used by the broader `tests/pty_session.rs`
/// suite for parity across the Phase 1 PTY integration tests.
const SMOKE_TIMEOUT: Duration = Duration::from_secs(2);

/// Drain envelopes from `rx` until an [`Envelope::ExitCodeNotification`]
/// is observed or [`SMOKE_TIMEOUT`] elapses. Returns every envelope
/// received during the wait so the test can assert on ordering.
///
/// Platform-neutral — both the unix and Windows smoke arms share this
/// helper. Duplicated from `tests/pty_session.rs::drain_until_exit`
/// because Rust integration tests are independent compilation units —
/// each `tests/<name>.rs` is its own crate and cannot import helpers
/// from peer test files. The alternative (a `tests/common/mod.rs`
/// shared helper) is heavier than warranted for Phase 1 with two smoke
/// tests; Phase 3+ can hoist common helpers if more `*_smoke.rs` files
/// appear.
async fn drain_until_exit(rx: &mut UnboundedReceiver<Envelope>) -> Vec<Envelope> {
    let mut envelopes = Vec::new();
    let _ = timeout(SMOKE_TIMEOUT, async {
        loop {
            match rx.recv().await {
                Some(env) => {
                    let is_exit = matches!(env, Envelope::ExitCodeNotification(_));
                    envelopes.push(env);
                    if is_exit {
                        return;
                    }
                }
                None => return,
            }
        }
    })
    .await;
    envelopes
}

/// Assert the spawn-smoke acceptance shape on a drained envelope list.
///
/// Both legs of the audit-row test behavior:
///   (a) "stdout chunk is delivered" — at least one [`Envelope::DataFrame`]
///       on the stream, every frame carries the spawned `session_id` and
///       `stream: DataStream::Stdout`, concatenated bytes contain
///       `"hello"`.
///   (b) "exit-code propagates" — exactly one
///       [`Envelope::ExitCodeNotification`], arriving as the LAST
///       envelope, with the spawned `session_id`, `exit_code == 0`, and
///       `signal_code == None` (Phase 1 always-None contract per
///       `pty_session.rs` module rustdoc §6; Windows additionally always
///       reports `signal_code: None` per `protocol.rs::ExitCodeNotification`
///       rustdoc).
///
/// Factored out so the unix and Windows arms share assertion code —
/// the only platform-specific axis is the spawn shape, not the
/// post-spawn observation contract.
///
/// `#[track_caller]` so a panic's reported location is the calling
/// `#[tokio::test]` (unix vs Windows arm) rather than a line inside
/// this helper. Without it, a regression triage from a stack trace
/// alone could not distinguish which platform arm fired the
/// assertion.
#[track_caller]
fn assert_spawn_smoke_envelopes(envelopes: &[Envelope], session_id: &str) {
    let data_frames: Vec<_> = envelopes
        .iter()
        .filter_map(|e| match e {
            Envelope::DataFrame(df) => Some(df),
            _ => None,
        })
        .collect();
    let exit_notifications: Vec<_> = envelopes
        .iter()
        .filter_map(|e| match e {
            Envelope::ExitCodeNotification(n) => Some(n),
            _ => None,
        })
        .collect();

    // Leg (a) — stdout chunk delivered with the spawned `hello`.
    assert!(
        !data_frames.is_empty(),
        "expected at least one DataFrame from the spawned echo, got envelopes: {envelopes:?}"
    );
    for df in &data_frames {
        assert_eq!(
            df.session_id, session_id,
            "DataFrame carries the spawned session_id"
        );
        assert_eq!(
            df.stream,
            DataStream::Stdout,
            "Phase 1 emits all DataFrames as Stdout (PTY merges stdout+stderr)"
        );
    }
    // Match the `tests/pty_session.rs::spawn_echo_emits_data_frame_then_exit`
    // idiom (lines 153-156) — `extend_from_slice` avoids the
    // per-frame `Vec<u8>` clone that `flat_map(|df| df.bytes.clone())`
    // would incur. Perf is irrelevant in test code; the win is local-
    // file consistency with the neighbor integration tests.
    let mut combined: Vec<u8> = Vec::new();
    for df in &data_frames {
        combined.extend_from_slice(&df.bytes);
    }
    let combined_str = String::from_utf8_lossy(&combined);
    assert!(
        combined_str.contains("hello"),
        "stdout payload should contain 'hello', got: {combined_str:?}"
    );

    // Leg (b) — exactly one ExitCodeNotification, exit_code 0,
    // signal_code None, and it arrives as the LAST envelope.
    assert_eq!(
        exit_notifications.len(),
        1,
        "expected exactly one ExitCodeNotification, got envelopes: {envelopes:?}"
    );
    assert!(
        matches!(envelopes.last(), Some(Envelope::ExitCodeNotification(_))),
        "ExitCodeNotification must arrive after the final DataFrame; envelopes: {envelopes:?}"
    );
    let exit = exit_notifications[0];
    assert_eq!(
        exit.session_id, session_id,
        "ExitCodeNotification carries the spawned session_id"
    );
    assert_eq!(exit.exit_code, 0, "echo should propagate exit_code: 0");
    assert_eq!(
        exit.signal_code, None,
        "Phase 1 emits signal_code: None for every exit per pty_session.rs §6"
    );
}

/// Phase 1 acceptance (unix arm): spawning `/bin/sh -c 'echo hello;
/// exit 0'` produces a [`DataFrame`] whose stdout payload contains
/// `"hello"` and exactly one [`ExitCodeNotification`] with `exit_code
/// == 0` and `signal_code == None`.
///
/// PTY canonical mode translates LF to CRLF on output, so the
/// observed payload may be `"hello\r\n"` rather than `"hello\n"`; the
/// assertion uses `.contains("hello")` so either form passes.
///
/// [`DataFrame`]: sidecar_rust_pty::protocol::DataFrame
/// [`ExitCodeNotification`]: sidecar_rust_pty::protocol::ExitCodeNotification
#[cfg(unix)]
#[tokio::test]
async fn spawn_smoke_sh_echo_hello_exits_zero() {
    let (registry, mut rx) = PtySessionRegistry::new();

    // Phase 1 acceptance criterion: `sh -c 'echo hello; exit 0'`.
    // `/bin/sh` (absolute) because `env_clear()` strips PATH in the
    // child — see module rustdoc "Spawn shape rationale".
    let response = registry
        .spawn(SpawnRequest {
            command: "/bin/sh".to_string(),
            args: vec!["-c".to_string(), "echo hello; exit 0".to_string()],
            env: Vec::new(),
            cwd: "/tmp".to_string(),
            rows: 24,
            cols: 80,
        })
        .await
        .expect("spawn of `sh -c 'echo hello; exit 0'` should succeed");

    let session_id = response.session_id.clone();
    let envelopes = drain_until_exit(&mut rx).await;
    assert_spawn_smoke_envelopes(&envelopes, &session_id);
}

/// Phase 1 acceptance (Windows arm): spawning `cmd.exe /c "echo hello"`
/// produces a [`DataFrame`] whose stdout payload contains `"hello"`
/// and exactly one [`ExitCodeNotification`] with `exit_code == 0` and
/// `signal_code == None`.
///
/// Windows `cmd.exe /c "echo hello"` writes `hello\r\n` and exits with
/// the command's exit code (0 on success), so the assertion shape is
/// identical to the unix arm. `signal_code` is always `None` on
/// Windows per [`ExitCodeNotification`] rustdoc — Windows has no POSIX
/// signal concept; the OS-level exit code carries the termination
/// reason.
///
/// This test does NOT exercise [`PtySessionRegistry::kill`] — the
/// child exits naturally — so the Phase 3 carve-out for Windows kill-
/// translation (Plan-024 §Invariants I-024-1 + I-024-2 → T-024-3-1)
/// does not gate it.
///
/// [`DataFrame`]: sidecar_rust_pty::protocol::DataFrame
/// [`ExitCodeNotification`]: sidecar_rust_pty::protocol::ExitCodeNotification
#[cfg(windows)]
#[tokio::test]
async fn spawn_smoke_cmd_exe_echo_hello_exits_zero() {
    let (registry, mut rx) = PtySessionRegistry::new();

    // Phase 1 acceptance criterion: `cmd.exe /c "echo hello"`.
    // Absolute path because `env_clear()` strips %PATH% / %WINDIR% in
    // the child — see module rustdoc "Spawn shape rationale". Raw
    // string literal (`r"..."`) so the backslashes are preserved
    // verbatim without double-escaping.
    let response = registry
        .spawn(SpawnRequest {
            command: r"C:\Windows\System32\cmd.exe".to_string(),
            args: vec!["/c".to_string(), "echo hello".to_string()],
            env: Vec::new(),
            // `r#"C:\"#` rather than `r"C:\"` — both are valid Rust
            // raw-string literals (the lexer reads `r#"`, body `C:\`,
            // closing `"#`), but `r"C:\"` looks like an escaped quote
            // at a glance. The `r#"..."#` form parallels the
            // `.expect(r#"..."#)` literal a few lines below and
            // removes the visual ambiguity.
            cwd: r#"C:\"#.to_string(),
            rows: 24,
            cols: 80,
        })
        .await
        .expect(r#"spawn of `cmd.exe /c "echo hello"` should succeed"#);

    let session_id = response.session_id.clone();
    let envelopes = drain_until_exit(&mut rx).await;
    assert_spawn_smoke_envelopes(&envelopes, &session_id);
}
