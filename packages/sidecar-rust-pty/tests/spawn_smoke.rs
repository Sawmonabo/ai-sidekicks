//! Plan-024 Phase 1 acceptance smoke test — `sh -c 'echo hello; exit 0'`.
//!
//! Pins the Phase 1 acceptance criterion verbatim from
//! `docs/plans/024-rust-pty-sidecar.md` §Test And Verification Plan:
//! "spawn smoke test (spawning `sh -c 'echo hello; exit 0'`) succeeds".
//!
//! The broader `tests/pty_session.rs` suite (T-024-1-4) covers
//! [`PtySessionRegistry`] behavior in depth (seq monotonicity, kill paths,
//! resize, write round-trip, race-closing). This file is intentionally
//! narrow — one test that exercises the exact spawn command shape pinned
//! by the audit row for T-024-1-5 and the Phase 1 acceptance criterion,
//! so a future reader bisecting "did the spawn smoke regress?" reaches a
//! single load-bearing test without sifting through nine peer cases.
//!
//! ## Platform scope
//!
//! `#![cfg(unix)]` because Phase 1 spawns `/bin/sh`, which is not a
//! Windows binary path. The audit row's Windows counterpart spawn
//! (`cmd.exe /c "echo hello"`) is **deferred to Phase 3 T-024-3-1**
//! when the Windows kill-translation and Windows-side sidecar wire-up
//! land (Plan-024 §Invariants I-024-1 + I-024-2; the same Phase 3 carve-
//! out documented on `pty_session.rs` module rustdoc §7). Phase 3 will
//! add a sibling `windows_spawn_smoke.rs` or extend this file with a
//! `#[cfg(windows)]` arm spawning `cmd.exe /c "echo hello"`.
//!
//! Module-level `#[cfg(unix)]` means the Windows CI matrix compiles
//! zero tests from this file rather than producing a CI failure on a
//! `/bin/sh`-not-found spawn.
//!
//! ## Spawn shape rationale
//!
//! The audit row writes the command as `sh -c 'echo hello; exit 0'`.
//! We send `/bin/sh -c 'echo hello; exit 0'` because
//! [`PtySessionRegistry::spawn`] calls `env_clear()` on the
//! [`portable_pty::CommandBuilder`] before applying the request's `env`
//! pairs — which means bare `sh` cannot be resolved via `PATH` from
//! inside the child. `/bin/sh` is the absolute path on every supported
//! Phase 1 unix platform (Linux + macOS), so the spawn is hermetic
//! regardless of the parent's environment. This matches the convention
//! the T-024-1-4 integration tests already use (see
//! `tests/pty_session.rs`).
//!
//! Plan-024 Phase 1 / T-024-1-5.

#![cfg(unix)]

use std::time::Duration;

use sidecar_rust_pty::protocol::{DataStream, Envelope, SpawnRequest};
use sidecar_rust_pty::pty_session::PtySessionRegistry;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::time::timeout;

/// Two-second budget for the smoke scenario. `echo hello; exit 0`
/// finishes in single-digit milliseconds even under CI load; 2 s is
/// two orders of magnitude of headroom while still failing fast on a
/// genuinely hung holder. Matches the budget used by the broader
/// `tests/pty_session.rs` suite for parity across the Phase 1 PTY
/// integration tests.
const SMOKE_TIMEOUT: Duration = Duration::from_secs(2);

/// Drain envelopes from `rx` until an [`Envelope::ExitCodeNotification`]
/// is observed or [`SMOKE_TIMEOUT`] elapses. Returns every envelope
/// received during the wait so the test can assert on ordering.
///
/// Duplicated from `tests/pty_session.rs::drain_until_exit` because Rust
/// integration tests are independent compilation units — each
/// `tests/<name>.rs` is its own crate and cannot import helpers from
/// peer test files. The alternative (a `tests/common/mod.rs` shared
/// helper) is heavier than warranted for Phase 1 with a single smoke
/// test; Phase 3+ can hoist common helpers if more `*_smoke.rs` files
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

/// Phase 1 acceptance: spawning `sh -c 'echo hello; exit 0'` produces
/// a [`DataFrame`] whose stdout payload contains `"hello"` and exactly
/// one [`ExitCodeNotification`] with `exit_code == 0` and
/// `signal_code == None`.
///
/// Pins both legs of the audit-row test behavior:
///   (a) "stdout chunk is delivered" — at least one DataFrame on the
///       stream, payload bytes contain `"hello"`.
///   (b) "exit-code propagates" — exactly one ExitCodeNotification,
///       exit_code == 0, signal_code == None (Phase 1 always-None
///       contract per `pty_session.rs` module rustdoc §6).
///
/// PTY canonical mode translates LF to CRLF on output, so the
/// observed payload may be `"hello\r\n"` rather than `"hello\n"`; the
/// assertion uses `.contains("hello")` so either form passes.
///
/// [`DataFrame`]: sidecar_rust_pty::protocol::DataFrame
/// [`ExitCodeNotification`]: sidecar_rust_pty::protocol::ExitCodeNotification
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

    // Partition the envelopes into the two kinds we care about. Any
    // unexpected variant fails the type-match on the next assertions.
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
        "expected at least one DataFrame from `echo hello`, got envelopes: {envelopes:?}"
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
    let combined: Vec<u8> = data_frames.iter().flat_map(|df| df.bytes.clone()).collect();
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
    assert_eq!(exit.exit_code, 0, "`exit 0` must propagate as exit_code: 0");
    assert_eq!(
        exit.signal_code, None,
        "Phase 1 emits signal_code: None for every exit per pty_session.rs §6"
    );
}
