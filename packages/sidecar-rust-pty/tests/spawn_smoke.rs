//! Windows spawn smoke test: spawn `cmd.exe /c "echo hello"`, then assert that stdout is delivered
//! and the exit code propagates. The unix registry behavior (spawn, sequence numbers, kill, write,
//! drop) is covered in `tests/pty_session.rs`.
//!
//! `PtySessionRegistry::spawn` clears the child environment, so `PATH` is empty and bare command
//! names do not resolve. The test passes an absolute binary (`C:\Windows\System32\cmd.exe`) and an
//! absolute working directory (`C:\`).

#![cfg(windows)]

use std::time::Duration;

use sidecar_rust_pty::protocol::{DataStream, Envelope, SpawnRequest};
use sidecar_rust_pty::pty_session::PtySessionRegistry;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::time::timeout;

/// Budget for a child to exit and its notification to arrive; the scenarios finish in milliseconds,
/// so 2 s only fails fast on a hang.
const SMOKE_TIMEOUT: Duration = Duration::from_secs(2);

/// Collects envelopes from `rx` until an [`Envelope::ExitCodeNotification`] arrives or
/// [`SMOKE_TIMEOUT`] elapses. Copied from `tests/pty_session.rs` because each integration test file
/// is its own crate.
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

/// Asserts the smoke contract on a drained envelope list: at least one stdout `DataFrame` for the
/// session whose bytes contain `"hello"`, then exactly one `ExitCodeNotification` as the last
/// envelope with `exit_code == 0` and `signal_code == None`.
///
/// `#[track_caller]` so a failure points at the calling test rather than this helper.
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

    // Stdout is delivered.
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
            "every DataFrame is Stdout (the PTY merges stdout and stderr)"
        );
    }
    // `extend_from_slice`, as in `tests/pty_session.rs`.
    let mut combined: Vec<u8> = Vec::new();
    for df in &data_frames {
        combined.extend_from_slice(&df.bytes);
    }
    let combined_str = String::from_utf8_lossy(&combined);
    assert!(
        combined_str.contains("hello"),
        "stdout payload should contain 'hello', got: {combined_str:?}"
    );

    // Exactly one exit notification, and it arrives last.
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
    assert_eq!(exit.signal_code, None, "signal_code is None for every exit");
}

/// Windows: spawning `cmd.exe /c "echo hello"` yields a [`DataFrame`] containing `"hello"` and one
/// [`ExitCodeNotification`] with `exit_code == 0`. `cmd.exe /c` returns the command's exit code,
/// and `signal_code` is `None`. `kill` is not exercised.
///
/// [`DataFrame`]: sidecar_rust_pty::protocol::DataFrame
/// [`ExitCodeNotification`]: sidecar_rust_pty::protocol::ExitCodeNotification
#[tokio::test]
async fn spawn_smoke_cmd_exe_echo_hello_exits_zero() {
    let (registry, mut rx) = PtySessionRegistry::new();

    // Absolute path because `env_clear()` strips PATH and WINDIR in the child.
    let response = registry
        .spawn(SpawnRequest {
            command: r"C:\Windows\System32\cmd.exe".to_string(),
            args: vec!["/c".to_string(), "echo hello".to_string()],
            env: Vec::new(),
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
