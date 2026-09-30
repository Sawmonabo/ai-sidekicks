//! Integration tests for the session registry against real `/bin/sh` children: a `portable-pty`
//! child must produce `DataFrame` and `ExitCodeNotification` envelopes on the outbound channel.
//!
//! Unix only: `kill()` returns `WindowsKillNotImplemented` on Windows, and the spawn shape uses
//! `/bin/sh`. The module-level `#![cfg(unix)]` leaves the Windows matrix with zero tests here
//! instead of failures.

#![cfg(unix)]

use std::time::Duration;

use sidecar_rust_pty::protocol::{
    DataStream, Envelope, KillRequest, PtySignal, SpawnRequest, WriteRequest,
};
use sidecar_rust_pty::pty_session::PtySessionRegistry;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::time::timeout;

/// Budget for a child to exit and its `ExitCodeNotification` to arrive; it finishes in
/// milliseconds, so 2 s only fails fast on a hang.
const EXIT_TIMEOUT: Duration = Duration::from_secs(2);

/// Collects envelopes from `rx` until an `ExitCodeNotification` arrives or `EXIT_TIMEOUT` elapses,
/// so tests can assert ordering without busy-waiting.
async fn drain_until_exit(rx: &mut UnboundedReceiver<Envelope>) -> Vec<Envelope> {
    let mut envelopes = Vec::new();
    let deadline_fut = timeout(EXIT_TIMEOUT, async {
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
    });
    let _ = deadline_fut.await;
    envelopes
}

/// An empty env keeps the spawn request minimal; these tests do not need one.
fn empty_env() -> Vec<(String, String)> {
    Vec::new()
}

#[tokio::test]
async fn spawn_echo_emits_data_frame_then_exit() {
    // A child writes a known string and exits 0: expect a `DataFrame` with those bytes, then an
    // `ExitCodeNotification` with exit code 0.
    let (registry, mut rx) = PtySessionRegistry::new();

    let response = registry
        .spawn(SpawnRequest {
            command: "/bin/sh".to_string(),
            args: vec!["-c".to_string(), "echo hello".to_string()],
            env: empty_env(),
            cwd: "/tmp".to_string(),
            rows: 24,
            cols: 80,
        })
        .await
        .expect("spawn should succeed");

    let session_id = response.session_id.clone();

    let envelopes = drain_until_exit(&mut rx).await;

    // At least one `DataFrame`, then exactly one `ExitCodeNotification` at the tail.
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

    assert!(
        !data_frames.is_empty(),
        "expected at least one DataFrame, got envelopes: {envelopes:?}"
    );
    assert_eq!(
        exit_notifications.len(),
        1,
        "expected exactly one ExitCodeNotification, got envelopes: {envelopes:?}"
    );

    assert!(matches!(
        envelopes.last().expect("non-empty"),
        Envelope::ExitCodeNotification(_)
    ));

    // Every `DataFrame` carries the session id and `Stdout` (a PTY merges stdout and stderr).
    for df in &data_frames {
        assert_eq!(df.session_id, session_id);
        assert_eq!(
            df.stream,
            DataStream::Stdout,
            "every DataFrame is Stdout (the PTY merges stdout and stderr)"
        );
    }

    // The exit notification has the same session id, exit code 0, and no signal code.
    let exit = exit_notifications[0];
    assert_eq!(exit.session_id, session_id);
    assert_eq!(exit.exit_code, 0);
    assert_eq!(exit.signal_code, None, "signal_code is None for every exit");

    // The PTY may translate LF to CRLF, so assert `contains` rather than equality.
    let mut combined: Vec<u8> = Vec::new();
    for df in &data_frames {
        combined.extend_from_slice(&df.bytes);
    }
    let combined_str = String::from_utf8_lossy(&combined);
    assert!(
        combined_str.contains("hello"),
        "combined DataFrame bytes should contain 'hello', got: {combined_str:?}"
    );
}

#[tokio::test]
async fn data_frame_seq_is_monotonic_per_session() {
    // 64 KiB of 'A' is eight 8 KiB chunks, so `seq` must increment. `printf` is more portable than
    // `yes | head` on macOS sh.
    let (registry, mut rx) = PtySessionRegistry::new();

    let cmd = "printf 'A%.0s' $(seq 1 65536)".to_string();
    let response = registry
        .spawn(SpawnRequest {
            command: "/bin/sh".to_string(),
            args: vec!["-c".to_string(), cmd],
            env: empty_env(),
            cwd: "/tmp".to_string(),
            rows: 24,
            cols: 80,
        })
        .await
        .expect("spawn should succeed");

    let envelopes = drain_until_exit(&mut rx).await;
    let data_frames: Vec<_> = envelopes
        .iter()
        .filter_map(|e| match e {
            Envelope::DataFrame(df) => Some(df),
            _ => None,
        })
        .collect();

    assert!(
        data_frames.len() >= 2,
        "expected ≥2 DataFrames from 64 KiB output, got {} (env count: {})",
        data_frames.len(),
        envelopes.len()
    );

    // seq starts at 0 and increments by 1 per chunk.
    for (i, df) in data_frames.iter().enumerate() {
        assert_eq!(
            df.seq, i as u64,
            "DataFrame {i} should carry seq={i}, got seq={}",
            df.seq
        );
        assert_eq!(df.session_id, response.session_id);
    }
}

#[tokio::test]
async fn parallel_sessions_get_distinct_session_ids() {
    // Ids come from a per-registry counter and must be distinct across spawns.
    let (registry, _rx) = PtySessionRegistry::new();

    let a = registry
        .spawn(SpawnRequest {
            command: "/bin/sh".to_string(),
            args: vec!["-c".to_string(), "exit 0".to_string()],
            env: empty_env(),
            cwd: "/tmp".to_string(),
            rows: 24,
            cols: 80,
        })
        .await
        .expect("spawn A should succeed");
    let b = registry
        .spawn(SpawnRequest {
            command: "/bin/sh".to_string(),
            args: vec!["-c".to_string(), "exit 0".to_string()],
            env: empty_env(),
            cwd: "/tmp".to_string(),
            rows: 24,
            cols: 80,
        })
        .await
        .expect("spawn B should succeed");

    assert_ne!(
        a.session_id, b.session_id,
        "parallel spawns must produce distinct session_ids"
    );
}

#[tokio::test]
async fn kill_sigterm_terminates_long_running_child() {
    // After SIGTERM to `sleep 30`, the exit notification must arrive within `EXIT_TIMEOUT`, well
    // before the sleep would end. This pins the unix kill path through `libc::kill`.
    let (registry, mut rx) = PtySessionRegistry::new();

    let response = registry
        .spawn(SpawnRequest {
            command: "/bin/sh".to_string(),
            args: vec!["-c".to_string(), "sleep 30".to_string()],
            env: empty_env(),
            cwd: "/tmp".to_string(),
            rows: 24,
            cols: 80,
        })
        .await
        .expect("spawn should succeed");

    let session_id = response.session_id.clone();

    // Let the child start sleeping first; a signal sent too early could hit the spawn before exec.
    tokio::time::sleep(Duration::from_millis(50)).await;

    let kill_response = registry
        .kill(KillRequest {
            session_id: session_id.clone(),
            signal: PtySignal::Sigterm,
        })
        .await
        .expect("kill should succeed");
    assert_eq!(kill_response.session_id, session_id);

    let envelopes = drain_until_exit(&mut rx).await;
    let exit = envelopes
        .iter()
        .find_map(|e| match e {
            Envelope::ExitCodeNotification(n) => Some(n),
            _ => None,
        })
        .unwrap_or_else(|| {
            panic!("expected ExitCodeNotification after kill, got envelopes: {envelopes:?}")
        });

    assert_eq!(exit.session_id, session_id);
    // A signal-terminated child gets portable-pty's sentinel `exit_code` 1, and `signal_code` is
    // always `None`.
    assert_eq!(exit.signal_code, None, "signal_code is always None");
    // The exact `exit_code` is not asserted; the load-bearing check is that the kill ended the
    // 30-second sleep within 2 seconds.
}

#[tokio::test]
async fn write_round_trips_through_cat() {
    // Spawn `cat`, write `hello\n`, and expect a `DataFrame` containing "hello". The PTY line
    // discipline echoes the input and `cat` prints it back, so it may appear twice; `contains`
    // accepts either.
    let (registry, mut rx) = PtySessionRegistry::new();

    let response = registry
        .spawn(SpawnRequest {
            command: "/bin/sh".to_string(),
            args: vec!["-c".to_string(), "cat".to_string()],
            env: empty_env(),
            cwd: "/tmp".to_string(),
            rows: 24,
            cols: 80,
        })
        .await
        .expect("spawn should succeed");

    // Let `cat` start reading stdin.
    tokio::time::sleep(Duration::from_millis(50)).await;

    let write_response = registry
        .write(WriteRequest {
            session_id: response.session_id.clone(),
            bytes: b"hello\n".to_vec(),
        })
        .await
        .expect("write should succeed");
    assert_eq!(write_response.session_id, response.session_id);

    // Collect for up to 500 ms, long enough for the echo and `cat`'s output.
    // test fast.
    let mut combined: Vec<u8> = Vec::new();
    let collect_fut = timeout(Duration::from_millis(500), async {
        while let Some(env) = rx.recv().await {
            if let Envelope::DataFrame(df) = env {
                combined.extend_from_slice(&df.bytes);
                if String::from_utf8_lossy(&combined).contains("hello") {
                    return;
                }
            }
        }
    });
    let _ = collect_fut.await;

    let s = String::from_utf8_lossy(&combined);
    assert!(
        s.contains("hello"),
        "write should round-trip through the PTY; combined output: {s:?}"
    );

    // Clean up: kill `cat`.
    let _ = registry
        .kill(KillRequest {
            session_id: response.session_id,
            signal: PtySignal::Sigkill,
        })
        .await;
}

/// Dropping the registry with an idle session must terminate its child and close the outbound
/// channel, so `main`'s writer task can exit.
///
/// The child (`sleep 30`) writes nothing and does not exit, so the reader and waiter tasks each
/// hold an outbound-sender clone that would never drop without the `Drop` impl. `Drop` kills the
/// child; its exit closes the PTY, the reader sees EOF, the waiter's `wait()` returns, and once
/// every sender clone drops `rx.recv()` returns `None`. The 1 s budget is far above that
/// sub-millisecond chain and fails fast on a hung registry. The test drains envelopes rather than
/// asserting there are none, because whether the waiter's `ExitCodeNotification` arrives before
/// `None` is a scheduling detail; the assertion is that `None` arrives in time. Without `Drop`,
/// `recv()` blocks until the sleep ends and the 1 s timeout fails the test.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn registry_drop_terminates_idle_session_and_closes_outbound_channel() {
    let (registry, mut rx) = PtySessionRegistry::new();

    // An idle child that writes nothing and does not exit within the test window.
    let _response = registry
        .spawn(SpawnRequest {
            command: "/bin/sh".to_string(),
            args: vec!["-c".to_string(), "sleep 30".to_string()],
            env: empty_env(),
            cwd: "/tmp".to_string(),
            rows: 24,
            cols: 80,
        })
        .await
        .expect("spawn should succeed");

    // Let the child start sleeping before the drop, so the kill does not race the spawn.
    tokio::time::sleep(Duration::from_millis(50)).await;

    // The `Drop` impl kills the child, which lets every outbound-sender clone drop.
    drop(registry);

    // Drain until `recv()` returns `None`, which is what lets `main`'s writer task exit, or the 1 s
    // budget elapses.
    let close_result = timeout(Duration::from_secs(1), async {
        loop {
            match rx.recv().await {
                Some(_envelope) => {
                    // The waiter may send a final ExitCodeNotification first; keep draining.
                    continue;
                }
                None => return,
            }
        }
    })
    .await;

    close_result.expect(
        "registry-drop did not close the outbound channel within 1s: \
         the reader + waiter tasks' UnboundedSender clones did not drop \
         (registry-drop's kill-on-drop chain failed to terminate the idle \
         child, so reader/waiter remain blocked). See \
         `PtySessionRegistry::drop` for the deadlock-closing rationale.",
    );
}

/// A child that ignores SIGHUP must still die from the SIGKILL escalation, so registry drop
/// completes in bounded time.
///
/// `trap "" HUP` swallows the soft kill. `Drop` then escalates to `libc::kill(pid, SIGKILL)` after
/// `DROP_KILL_ESCALATION_DEADLINE` (1000 ms), and the outbound channel closes shortly after the
/// child dies. The test waits up to 2000 ms, twice the deadline, to allow for scheduler delay on a
/// loaded CI runner. Without the escalation `sleep 60` keeps running and the wait times out.
/// `exec sleep 60` makes the pid portable-pty recorded the `sleep` process itself, with the ignored
/// signal inherited, rather than a shell that might fork and wait (POSIX allows but does not
/// require the shell to skip the fork).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn registry_drop_escalates_to_sigkill_for_sighup_ignoring_child() {
    let (registry, mut rx) = PtySessionRegistry::new();

    // `trap "" HUP` swallows the soft kill; `exec sleep 60` makes the recorded pid the sleep
    // process itself. Only the SIGKILL escalation can end it within the test window.
    let _response = registry
        .spawn(SpawnRequest {
            command: "/bin/sh".to_string(),
            args: vec!["-c".to_string(), "trap '' HUP; exec sleep 60".to_string()],
            env: empty_env(),
            cwd: "/tmp".to_string(),
            rows: 24,
            cols: 80,
        })
        .await
        .expect("spawn should succeed");

    // The shell must have run the `trap` before the drop; 100 ms is a conservative margin.
    tokio::time::sleep(Duration::from_millis(100)).await;

    drop(registry);

    // Twice `DROP_KILL_ESCALATION_DEADLINE` (2000 ms); see the doc comment for the timeline.
    let close_result = timeout(Duration::from_millis(2000), async {
        loop {
            match rx.recv().await {
                Some(_envelope) => continue,
                None => return,
            }
        }
    })
    .await;

    close_result.expect(
        "registry-drop on a SIGHUP-ignoring child did not close the \
         outbound channel within 2× DROP_KILL_ESCALATION_DEADLINE (2s): \
         the SIGKILL escalation appears broken. The child has \
         `trap \"\" HUP; sleep 60` so the SIGHUP soft kill is a no-op; \
         the escalation thread MUST fire SIGKILL after 1000 ms. See \
         `PtySessionRegistry::drop` and the \
         `DROP_KILL_ESCALATION_DEADLINE` constant.",
    );
}
