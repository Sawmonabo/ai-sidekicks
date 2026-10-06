//! Windows spawn smoke test: spawn `cmd.exe /c "echo hello"`, then assert that stdout is delivered
//! and the exit code propagates. The unix registry behavior (spawn, sequence numbers, kill, write,
//! drop) is covered in `tests/session.rs`.
//!
//! `PtySessionRegistry::spawn` clears the child environment, so `PATH` is empty and bare command
//! names do not resolve. The test passes an absolute binary (`C:\Windows\System32\cmd.exe`) and an
//! absolute working directory (`C:\`).

#![cfg(windows)]

mod common;

use sidecar_rust_pty::protocol::SpawnRequest;
use sidecar_rust_pty::session::PtySessionRegistry;

use common::{assert_hello_then_clean_exit, drain_until_exit, empty_env};

/// `cmd.exe /c` returns the command's exit code, so `echo hello` exits 0 with `signal_code` `None`.
/// `kill` is not exercised.
#[tokio::test]
async fn spawn_smoke_cmd_exe_echo_hello_exits_zero() {
    let (registry, mut rx) = PtySessionRegistry::new();

    // Absolute path because `env_clear()` strips PATH and WINDIR in the child.
    let response = registry
        .spawn(SpawnRequest {
            command: r"C:\Windows\System32\cmd.exe".to_string(),
            args: vec!["/c".to_string(), "echo hello".to_string()],
            env: empty_env(),
            cwd: r#"C:\"#.to_string(),
            rows: 24,
            cols: 80,
        })
        .await
        .expect(r#"spawn of `cmd.exe /c "echo hello"` should succeed"#);

    let envelopes = drain_until_exit(&mut rx).await;
    assert_hello_then_clean_exit(&envelopes, &response.session_id);
}
