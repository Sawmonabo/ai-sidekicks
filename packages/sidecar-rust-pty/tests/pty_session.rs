//! Integration tests for the session registry against real `/bin/sh` children: a `portable-pty`
//! child must produce `DataFrame` and `ExitCodeNotification` envelopes on the outbound channel.
//!
//! Unix only: `kill()` returns `WindowsKillNotImplemented` on Windows, and the spawn shape uses
//! `/bin/sh`. The module-level `#![cfg(unix)]` leaves the Windows matrix with zero tests here
//! instead of failures.

#![cfg(unix)]

use std::time::Duration;

use sidecar_rust_pty::protocol::{
    DataStream, Envelope, KillRequest, PtySignal, ResizeRequest, SpawnRequest, WriteRequest,
};
use sidecar_rust_pty::pty_session::{PtySessionError, PtySessionRegistry};
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
            "Phase 1 emits all DataFrames as Stdout (PTY merges stdout+stderr)"
        );
    }

    // The exit notification has the same session id, exit code 0, and no signal code.
    let exit = exit_notifications[0];
    assert_eq!(exit.session_id, session_id);
    assert_eq!(exit.exit_code, 0);
    assert_eq!(
        exit.signal_code, None,
        "Phase 1 emits signal_code: None for every exit per module rustdoc"
    );

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
async fn resize_on_unknown_session_returns_unknown_session_error() {
    let (registry, _rx) = PtySessionRegistry::new();
    let err = registry
        .resize(ResizeRequest {
            session_id: "no-such-session".to_string(),
            rows: 30,
            cols: 100,
        })
        .await
        .expect_err("resize on unknown session must fail");
    assert!(
        matches!(err, PtySessionError::UnknownSession(ref id) if id == "no-such-session"),
        "expected UnknownSession error, got: {err:?}"
    );
}

#[tokio::test]
async fn write_on_unknown_session_returns_unknown_session_error() {
    let (registry, _rx) = PtySessionRegistry::new();
    let err = registry
        .write(WriteRequest {
            session_id: "no-such-session".to_string(),
            bytes: b"hello\n".to_vec(),
        })
        .await
        .expect_err("write on unknown session must fail");
    assert!(
        matches!(err, PtySessionError::UnknownSession(ref id) if id == "no-such-session"),
        "expected UnknownSession error, got: {err:?}"
    );
}

#[tokio::test]
async fn kill_on_unknown_session_returns_unknown_session_error() {
    let (registry, _rx) = PtySessionRegistry::new();
    let err = registry
        .kill(KillRequest {
            session_id: "no-such-session".to_string(),
            signal: PtySignal::Sigterm,
        })
        .await
        .expect_err("kill on unknown session must fail");
    assert!(
        matches!(err, PtySessionError::UnknownSession(ref id) if id == "no-such-session"),
        "expected UnknownSession error, got: {err:?}"
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
    assert_eq!(
        exit.signal_code, None,
        "Phase 1 always emits signal_code: None"
    );
    // The exact `exit_code` is not asserted; the load-bearing check is that the kill ended the
    // 30-second sleep within 2 seconds.
}

#[tokio::test]
async fn resize_on_active_session_succeeds() {
    let (registry, _rx) = PtySessionRegistry::new();
    let response = registry
        .spawn(SpawnRequest {
            command: "/bin/sh".to_string(),
            // Idle on stdin so the session stays alive for the resize.
            args: vec!["-c".to_string(), "cat".to_string()],
            env: empty_env(),
            cwd: "/tmp".to_string(),
            rows: 24,
            cols: 80,
        })
        .await
        .expect("spawn should succeed");

    let resize_response = registry
        .resize(ResizeRequest {
            session_id: response.session_id.clone(),
            rows: 40,
            cols: 132,
        })
        .await
        .expect("resize should succeed");

    assert_eq!(resize_response.session_id, response.session_id);

    // Clean up: kill `cat`.
    let _ = registry
        .kill(KillRequest {
            session_id: response.session_id,
            signal: PtySignal::Sigkill,
        })
        .await;
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

#[tokio::test]
async fn post_exit_kill_returns_unknown_session_not_recycled_pid() {
    // After a child exits, `kill()` must not report success: the `exited` flag makes it return
    // `UnknownSession`, or `Io(ESRCH)` if it lands in the narrow window after the store. A recycled
    // pid cannot be exercised deterministically, so this pins that the outcome is never
    // `Ok(KillResponse)`. The `ExitCodeNotification` is sent after the `exited` store, so once it
    // arrives the flag is set.
    let (registry, mut rx) = PtySessionRegistry::new();

    let response = registry
        .spawn(SpawnRequest {
            command: "/bin/sh".to_string(),
            args: vec!["-c".to_string(), "exit 0".to_string()],
            env: empty_env(),
            cwd: "/tmp".to_string(),
            rows: 24,
            cols: 80,
        })
        .await
        .expect("spawn should succeed");

    let session_id = response.session_id.clone();

    // The flag is set by the time the notification arrives.
    let envelopes = drain_until_exit(&mut rx).await;
    let saw_exit = envelopes
        .iter()
        .any(|e| matches!(e, Envelope::ExitCodeNotification(_)));
    assert!(
        saw_exit,
        "expected ExitCodeNotification before testing post-exit kill, got: {envelopes:?}"
    );

    // The waiter may not have removed the session yet, so accept `UnknownSession` (flag check or
    // map removal) or `Io` (ESRCH). `Ok` is the forbidden outcome.
    let result = registry
        .kill(KillRequest {
            session_id: session_id.clone(),
            signal: PtySignal::Sigkill,
        })
        .await;

    match result {
        Err(PtySessionError::UnknownSession(_)) => {
            // The `exited` flag or the map removal short-circuited.
        }
        Err(PtySessionError::Io(_)) => {
            // The flag race was lost and `kill(2)` returned an error (ESRCH, or another error if
            // the pid was recycled to a process we do not own). No unrelated process was signaled.
        }
        Ok(_) => panic!(
            "post-exit kill MUST NOT return Ok — it could be signaling a recycled pid. \
             session_id={session_id:?}, envelopes={envelopes:?}"
        ),
        Err(other) => panic!(
            "unexpected error variant for post-exit kill: {other:?} \
             (expected UnknownSession or Io); session_id={session_id:?}"
        ),
    }
}

/// A `DataFrame` the child writes must reach the outbound channel before the session's
/// `ExitCodeNotification`.
///
/// The waiter awaits the reader task without a timeout, so the notification cannot fire until the
/// reader has seen every byte and PTY EOF (see `spawn_waiter_task` for why there is no timeout). On
/// macOS and Linux the reader keeps pace with the child, so this passes even without the drain and
/// pins the contract rather than catching the race. On Windows ConPTY, where master-side EOF can
/// lag the child's exit, the race is readily visible. The child writes 256 KiB, which is 32 chunks
/// of `READ_CHUNK_BYTES` (8 KiB); `drain_until_exit` stops at the first notification, so one that
/// arrived early would leave the byte total short.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn exit_notification_arrives_after_final_data_frame() {
    let (registry, mut rx) = PtySessionRegistry::new();

    // 256 KiB of 'A' (32 chunks of 8 KiB), then `exit 0`. `printf 'A%.0s' $(seq ...)` emits one 'A'
    // per argument.
    const PAYLOAD_BYTES: usize = 256 * 1024;
    let cmd = format!("printf 'A%.0s' $(seq 1 {PAYLOAD_BYTES}); exit 0");
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
    let session_id = response.session_id.clone();

    // Drain to the first `ExitCodeNotification`; the waiter's reader drain means every chunk
    // precedes it.
    let envelopes = drain_until_exit(&mut rx).await;

    // The notification must be the last envelope; without the waiter's drain there is no ordering
    // guarantee even when a run happens to pass.
    assert!(
        matches!(envelopes.last(), Some(Envelope::ExitCodeNotification(_))),
        "ExitCodeNotification must arrive after the final DataFrame; got envelopes: \
         (count={count}, last variant: {last:?})",
        count = envelopes.len(),
        last = envelopes.last().map(|e| match e {
            Envelope::DataFrame(_) => "DataFrame",
            Envelope::ExitCodeNotification(_) => "ExitCodeNotification",
            _ => "other",
        })
    );

    // All 256 KiB must arrive before the notification: `drain_until_exit` stops at the first one,
    // so a late chunk would leave the total short.
    let data_total: usize = envelopes
        .iter()
        .filter_map(|e| match e {
            Envelope::DataFrame(df) => {
                assert_eq!(
                    df.session_id, session_id,
                    "DataFrame must carry the spawned session_id"
                );
                assert_eq!(
                    df.stream,
                    DataStream::Stdout,
                    "Phase 1 emits all DataFrames as Stdout (PTY merges streams)"
                );
                Some(df.bytes.len())
            }
            _ => None,
        })
        .sum();
    assert_eq!(
        data_total,
        PAYLOAD_BYTES,
        "expected all {PAYLOAD_BYTES} bytes of 'A' before ExitCodeNotification, got \
         data_total={data_total} (envelopes={count}). A shortfall indicates the waiter \
         fired ExitCodeNotification before the reader finished pumping — see \
         `READER_DRAIN_TIMEOUT` + `spawn_waiter_task` for the drain shape that pins \
         this ordering.",
        count = envelopes.len()
    );

    // Exactly one notification, with the spawned id and exit code 0.
    let exit_notifications: Vec<_> = envelopes
        .iter()
        .filter_map(|e| match e {
            Envelope::ExitCodeNotification(n) => Some(n),
            _ => None,
        })
        .collect();
    assert_eq!(
        exit_notifications.len(),
        1,
        "expected exactly one ExitCodeNotification, got envelopes: {envelopes:?}"
    );
    assert_eq!(exit_notifications[0].session_id, session_id);
    assert_eq!(exit_notifications[0].exit_code, 0);
    assert_eq!(exit_notifications[0].signal_code, None);
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

/// The same as `registry_drop_terminates_idle_session_and_closes_outbound_channel` with two idle
/// children: each session holds two sender clones (reader and waiter), and all four must drop
/// before `rx.recv()` returns `None`.
///
/// `HashMap` iteration order is randomized per process, so runs vary the kill interleaving; a flaky
/// result would reveal an ordering or partial-drain bug that one session cannot. The 1 s budget
/// follows the single-session test.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn registry_drop_terminates_two_idle_sessions_and_closes_outbound_channel() {
    let (registry, mut rx) = PtySessionRegistry::new();

    // Two idle children: both sessions' reader and waiter clones must drop.
    for _ in 0..2 {
        registry
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
    }

    // Let both children start sleeping before the drop.
    tokio::time::sleep(Duration::from_millis(50)).await;

    // `Drop` kills both children in randomized map order; the channel closes only if both kill
    // chains finish.
    drop(registry);

    let close_result = timeout(Duration::from_secs(1), async {
        loop {
            match rx.recv().await {
                Some(_envelope) => {
                    // Drain the final notifications; the observation that matters is `None`.
                    continue;
                }
                None => return,
            }
        }
    })
    .await;

    close_result.expect(
        "registry-drop with two idle sessions did not close the outbound \
         channel within 1s: one or both kill-on-drop chains failed to \
         terminate the idle child, leaving reader/waiter UnboundedSender \
         clones alive. HashMap drain order is randomized per-process; \
         rerun a few times if this flakes to surface ordering bugs. See \
         `PtySessionRegistry::drop` for the deadlock-closing rationale.",
    );
}

/// A well-behaved child must die from the soft kill (SIGHUP) alone, before the SIGKILL escalation
/// fires.
///
/// `registry_drop_terminates_idle_session_and_closes_outbound_channel` uses a 1 s budget, which
/// cannot tell the soft kill from the escalation because `DROP_KILL_ESCALATION_DEADLINE` is also
/// 1000 ms. This test waits only 300 ms, so the channel must close through the soft kill alone. It
/// catches a regression that removes or breaks the soft kill (the channel would then wait for the
/// escalation and miss 300 ms). If it flakes, first check that the soft kill still terminates
/// well-behaved children before raising the budget.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn registry_drop_terminates_well_behaved_child_without_escalation() {
    let (registry, mut rx) = PtySessionRegistry::new();

    // A well-behaved `sleep 30` exits on SIGHUP within milliseconds, so escalation must not be
    // needed.
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

    // Let the child start sleeping before the drop.
    tokio::time::sleep(Duration::from_millis(50)).await;

    drop(registry);

    // 300 ms is well below the 1000 ms escalation deadline; a failure means the soft kill has
    // regressed.
    let close_result = timeout(Duration::from_millis(300), async {
        loop {
            match rx.recv().await {
                Some(_envelope) => continue,
                None => return,
            }
        }
    })
    .await;

    close_result.expect(
        "registry-drop on a well-behaved sleep child did not close \
         the outbound channel within 300ms (< DROP_KILL_ESCALATION_DEADLINE): \
         Phase 1 SIGHUP soft-kill path appears broken. The Phase 2 SIGKILL \
         escalation should NOT be reachable on this child within the \
         budget. See `PtySessionRegistry::drop` Phase 1 arm.",
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
         Phase 2 SIGKILL escalation appears broken. The child has \
         `trap \"\" HUP; sleep 60` so Phase 1 SIGHUP is a no-op; the \
         escalation thread MUST fire SIGKILL after 1000 ms. See \
         `PtySessionRegistry::drop` Phase 2 arm + the \
         `DROP_KILL_ESCALATION_DEADLINE` constant.",
    );
}
