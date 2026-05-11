//! Integration tests for the per-session PTY holder.
//!
//! Exercises [`PtySessionRegistry`] against real `/bin/sh` children — the
//! T-024-1-5 dispatcher smoke test is the next layer of integration coverage,
//! but these tests are the load-bearing assertions that the Phase 1 holder
//! actually wires a `portable-pty` child through to `DataFrame` +
//! `ExitCodeNotification` envelopes on the outbound channel.
//!
//! ## Platform scope
//!
//! These tests are unix-only because:
//! 1. The holder's `kill()` is unix-only at Phase 1 (Windows arm returns
//!    [`WindowsKillNotImplemented`] per the audit row's I-024-1/I-024-2
//!    Phase 3 deferral).
//! 2. The spawn shape uses `/bin/sh` which is not a Windows binary path.
//!
//! Phase 3 T-024-3-1 will add Windows-specific cases when the kill-
//! translation arm lands. Module-level `#[cfg(unix)]` gating means the
//! Windows CI matrix sees zero tests in this file rather than a CI failure.
//!
//! Plan-024 Phase 1 / T-024-1-4.

#![cfg(unix)]

use std::time::Duration;

use sidecar_rust_pty::protocol::{
    DataStream, Envelope, KillRequest, PtySignal, ResizeRequest, SpawnRequest, WriteRequest,
};
use sidecar_rust_pty::pty_session::{PtySessionError, PtySessionRegistry};
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::time::timeout;

/// Two-second polling budget for the "child exits + ExitCodeNotification
/// arrives" path. `echo hello; exit 0` typically finishes within a few
/// milliseconds even under CI load; 2 s is two orders of magnitude of
/// headroom while still failing fast on a genuinely hung holder.
const EXIT_TIMEOUT: Duration = Duration::from_secs(2);

/// Drain envelopes from `rx` until an `ExitCodeNotification` is observed
/// or `EXIT_TIMEOUT` elapses, returning every envelope received during
/// the wait. Used so tests can assert on the arrival ordering of
/// `DataFrame` + `ExitCodeNotification` without busy-waiting.
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

/// Empty env hands the child whatever portable-pty's CommandBuilder
/// considers safe defaults. We could pass the parent's env via
/// `std::env::vars`, but `/bin/sh -c 'echo hello'` doesn't need any env
/// for the test to pass — keeping the spawn request minimal makes the
/// test focused on the holder's wire shape, not on env propagation.
fn empty_env() -> Vec<(String, String)> {
    Vec::new()
}

#[tokio::test]
async fn spawn_echo_emits_data_frame_then_exit() {
    // The canonical Phase 1 acceptance scenario: spawn a child that writes
    // a known string then exits 0, and assert we observe a DataFrame with
    // those bytes followed by an ExitCodeNotification with exit_code 0.
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

    // Verify ordering: at least one DataFrame, then exactly one
    // ExitCodeNotification at the tail.
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

    // The exit notification arrives last.
    assert!(matches!(
        envelopes.last().expect("non-empty"),
        Envelope::ExitCodeNotification(_)
    ));

    // All DataFrames carry the spawned session_id and stream: Stdout
    // (per the Phase 1 PTY-merge-streams design note).
    for df in &data_frames {
        assert_eq!(df.session_id, session_id);
        assert_eq!(
            df.stream,
            DataStream::Stdout,
            "Phase 1 emits all DataFrames as Stdout (PTY merges stdout+stderr)"
        );
    }

    // The exit notification carries the same session id, exit_code 0
    // (echo + exit 0 → 0), and signal_code: None (Phase 1 contract).
    let exit = exit_notifications[0];
    assert_eq!(exit.session_id, session_id);
    assert_eq!(exit.exit_code, 0);
    assert_eq!(
        exit.signal_code, None,
        "Phase 1 emits signal_code: None for every exit per module rustdoc §6"
    );

    // Concatenated output must contain "hello". PTY canonical mode
    // translates LF to CRLF on output so the literal bytes might be
    // "hello\r\n" — assert on `contains` rather than exact equality.
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
    // Pump a payload large enough that the 8 KiB chunker actually
    // emits multiple DataFrames so we can observe `seq` increment.
    //
    // The shell command writes 64 KiB of 'A' (8x the chunk threshold)
    // then exits. Even with one read-coalesce, this is large enough
    // to force at least two chunks. `printf` is more portable than
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
    // Two spawns from the same registry must mint distinct session
    // ids. This pins the `mint_session_id` contract: ids are
    // process-wide unique, not just unique within a single spawn
    // path.
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
    // Spawn a `sleep 30` child, then send SIGTERM. The waiter task
    // should fire ExitCodeNotification within EXIT_TIMEOUT — well
    // before the sleep would naturally complete. This pins the
    // unix kill path end-to-end through `libc::kill`.
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

    // Give the child a beat to actually be sleeping before we signal
    // it. Without this, the signal may race the spawn and either
    // (a) hit the parent's pre-exec stage on some platforms or
    // (b) the child has not yet installed its default SIGTERM
    // handler. 50 ms is generous for both Linux and macOS.
    tokio::time::sleep(Duration::from_millis(50)).await;

    let kill_response = registry
        .kill(KillRequest {
            session_id: session_id.clone(),
            signal: PtySignal::Sigterm,
        })
        .await
        .expect("kill should succeed");
    assert_eq!(kill_response.session_id, session_id);

    // Wait for the exit notification.
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
    // SIGTERM-killed child: exit_code is portable-pty's "signal-
    // terminated" sentinel (1) per the From<std::process::ExitStatus>
    // implementation in portable-pty 0.9 lib.rs:208-237.
    // signal_code is None at Phase 1 per module rustdoc §6.
    assert_eq!(
        exit.signal_code, None,
        "Phase 1 always emits signal_code: None"
    );
    // We don't assert on the exact exit_code value since portable-pty's
    // mapping (signal-terminated → code=1) is documented but not
    // load-bearing for the Phase 1 holder. The presence of the
    // ExitCodeNotification + the kill having actually terminated the
    // 30-second sleep within 2 seconds IS the load-bearing assertion.
}

#[tokio::test]
async fn resize_on_active_session_succeeds() {
    let (registry, _rx) = PtySessionRegistry::new();
    let response = registry
        .spawn(SpawnRequest {
            command: "/bin/sh".to_string(),
            // Sit idle waiting for stdin so the session stays alive
            // long enough for the resize.
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

    // Clean up — kill the cat to avoid leaving a zombie test process.
    let _ = registry
        .kill(KillRequest {
            session_id: response.session_id,
            signal: PtySignal::Sigkill,
        })
        .await;
}

#[tokio::test]
async fn active_session_count_tracks_lifecycle() {
    // Verifies the session-map invariant: insertion at spawn, removal
    // at waiter-emitted exit. Uses the `active_session_count()` accessor
    // (a `pub` method also earmarked for the T-024-1-5 dispatcher
    // health-check path).
    let (registry, mut rx) = PtySessionRegistry::new();
    assert_eq!(registry.active_session_count().await, 0);

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

    // Immediately post-spawn the count is 1 (the waiter task is
    // running but the child has not yet exited).
    assert_eq!(registry.active_session_count().await, 1);

    // Wait for the exit notification — proves the waiter has fired
    // and removed the session from the map.
    let _ = drain_until_exit(&mut rx).await;

    // Give the waiter a beat to acquire the map lock and remove the
    // session. The waiter emits the notification BEFORE removing the
    // session (so `drain_until_exit` returns before removal completes).
    // 50 ms is generous; Tokio's lock contention should resolve in
    // microseconds.
    for _ in 0..20 {
        if registry.active_session_count().await == 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!(
        "session {:?} should have been removed from the registry within 1 s of exit",
        response.session_id
    );
}

#[tokio::test]
async fn write_round_trips_through_cat() {
    // Spawn `cat` (echoes stdin to stdout via PTY canonical mode),
    // call `registry.write(b"hello\n")`, assert a subsequent DataFrame
    // contains the literal "hello" payload. This is the happy-path
    // coverage for the write surface — the existing
    // `write_on_unknown_session_returns_unknown_session_error` test
    // pins the negative path, but the success path had no coverage
    // until this test (POLISH 13 from round-2 review).
    //
    // PTY canonical-mode echo: the slave-side line discipline echoes
    // every input byte back through the master, so the daemon
    // observes its own write as a DataFrame. Plus `cat` itself reads
    // the line and writes it back — so we may see two echoes of
    // "hello" (one from line discipline, one from cat's stdout).
    // The assertion is just `.contains("hello")` so either case
    // passes.
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

    // Give `cat` a beat to actually be reading from its stdin.
    tokio::time::sleep(Duration::from_millis(50)).await;

    let write_response = registry
        .write(WriteRequest {
            session_id: response.session_id.clone(),
            bytes: b"hello\n".to_vec(),
        })
        .await
        .expect("write should succeed");
    assert_eq!(write_response.session_id, response.session_id);

    // Collect DataFrames for up to 500 ms — long enough for line
    // discipline + cat to both round-trip; short enough to keep the
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

    // Clean up — kill cat so we don't leave a zombie test process.
    let _ = registry
        .kill(KillRequest {
            session_id: response.session_id,
            signal: PtySignal::Sigkill,
        })
        .await;
}

#[tokio::test]
async fn post_exit_kill_returns_unknown_session_not_recycled_pid() {
    // Pins the race-closing fix from round-2 review (ACTIONABLE):
    // after a child has exited naturally, the `exited` flag set
    // inside the waiter task's `spawn_blocking` closure must cause
    // subsequent `kill()` calls to short-circuit with
    // `UnknownSession` BEFORE `libc::kill` can fire at a pid the
    // kernel may have already recycled.
    //
    // The test cannot deterministically exercise the recycled-pid
    // failure mode (that requires concurrent fork+exec from another
    // process), but it CAN pin the load-bearing behavior: a kill
    // attempt after the waiter has observed exit returns
    // `UnknownSession` (or `Io(ESRCH)` if the kill landed in the
    // narrow post-store-pre-syscall window). The assertion accepts
    // either: both are correct shapes — what is NOT acceptable is a
    // silent `Ok(KillResponse)` reporting success against a recycled
    // pid.
    //
    // To make the post-exit moment observable from the test, we
    // await the `ExitCodeNotification` (which is emitted AFTER the
    // `exited` store inside the spawn_blocking closure — the store
    // happens-before the notification send). Once we see the
    // notification, the flag is guaranteed to be `true`.
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

    // Wait for the ExitCodeNotification — this is the moment the
    // waiter task has gone past its `wait()` return + flag store.
    let envelopes = drain_until_exit(&mut rx).await;
    let saw_exit = envelopes
        .iter()
        .any(|e| matches!(e, Envelope::ExitCodeNotification(_)));
    assert!(
        saw_exit,
        "expected ExitCodeNotification before testing post-exit kill, got: {envelopes:?}"
    );

    // The session may or may not have been removed from the registry
    // map by now (the waiter's `map.remove(&session_id)` happens
    // after the notification send). Either way, kill MUST NOT report
    // success — either UnknownSession (flag-check short-circuit OR
    // map-removed short-circuit) or Io (ESRCH from a no-longer-
    // killable pid). The forbidden outcome is `Ok(KillResponse)`.
    let result = registry
        .kill(KillRequest {
            session_id: session_id.clone(),
            signal: PtySignal::Sigkill,
        })
        .await;

    match result {
        Err(PtySessionError::UnknownSession(_)) => {
            // Expected: the `exited` flag short-circuited (or the
            // waiter already removed the session from the map).
        }
        Err(PtySessionError::Io(_)) => {
            // Acceptable: the flag race lost in this run; libc::kill
            // landed with ESRCH ("no such process") because the
            // kernel had already reaped the pid AND the pid happened
            // not to be recycled yet. This is still a correctness-
            // preserving outcome — we did not signal an unrelated
            // process. The ESRCH error number is platform-specific
            // (3 on Linux + macOS), but we don't assert on the raw
            // value because libc::kill could in principle return EPERM
            // or another error if the pid was recycled to a non-
            // owned process; the load-bearing assertion is that the
            // operation did NOT report success.
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

/// Lifecycle smoke for the `PtySessionRegistry::spawn` insert-before-spawn
/// ordering — the pre-fix shape spawned the reader + waiter tasks BEFORE
/// inserting the handle into `self.sessions`. With a fast-exiting child
/// (`sh -c 'exit 0'`) and the multi-threaded runtime used in production,
/// the waiter could in principle drive its
/// `sessions.lock().await; map.remove(&id)` to completion before
/// `spawn()`'s own `insert` landed, leaking a stale entry for an
/// already-reaped session.
///
/// The fix inserts the handle into `self.sessions` BEFORE spawning either
/// task, so the waiter's `map.remove(&id)` is guaranteed to run after
/// the entry exists. This test exercises the post-fix lifecycle and
/// pins the load-bearing contract: spawning N fast-exiting children
/// and draining all N `ExitCodeNotification`s must leave the registry
/// at zero active sessions.
///
/// ## Scope and limits
///
/// This is a **positive-coverage smoke** for the lifecycle contract,
/// not a deterministic bug reproducer. The pre-fix race fires only if
/// the waiter task's `spawn_blocking → child.wait → notify → lock →
/// remove` chain completes during the few microseconds between
/// `spawn_waiter_task(...)` returning and `self.sessions.lock().await.
/// insert(...)` completing on the calling thread. For
/// `sh -c 'exit 0'` even with `multi_thread` + concurrent spawns the
/// race window is too narrow to fire deterministically in CI — empirical
/// validation against the buggy shape passes. The fix is enforced
/// structurally by code review (insert MUST happen-before the spawn
/// calls in `spawn()`); this test catches gross lifecycle regressions
/// (e.g. a waiter that never removes, or a spawn that never inserts)
/// that broadly break the contract.
///
/// ## Why `multi_thread` runtime
///
/// `#[tokio::test]` defaults to `flavor = "current_thread"`, which
/// serializes spawn() through one executor thread and hides the
/// scheduling shape that production uses. `main.rs` runs under a
/// multi-threaded `#[tokio::main]`, where the waiter can land on a
/// peer worker while spawn() is still on the calling thread. Pinning
/// `flavor = "multi_thread"` here keeps the test's scheduler aligned
/// with production so any future structural regression is exercised
/// under the same conditions the bug originally arose under.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fast_exiting_child_lifecycle_returns_registry_to_zero() {
    let (registry, mut rx) = PtySessionRegistry::new();

    const N: usize = 16;
    let mut session_ids: Vec<String> = Vec::with_capacity(N);
    for _ in 0..N {
        let resp = registry
            .spawn(SpawnRequest {
                command: "/bin/sh".to_string(),
                args: vec!["-c".to_string(), "exit 0".to_string()],
                env: empty_env(),
                cwd: "/tmp".to_string(),
                rows: 24,
                cols: 80,
            })
            .await
            .expect("spawn of `sh -c 'exit 0'` should succeed");
        session_ids.push(resp.session_id);
    }

    // Drain envelopes until we observe one `ExitCodeNotification` per
    // spawn. 10 s is generous; in practice all 16 finish within tens
    // of milliseconds on every supported platform.
    let mut exits_seen: std::collections::HashSet<String> =
        std::collections::HashSet::with_capacity(N);
    let _ = timeout(Duration::from_secs(10), async {
        while exits_seen.len() < N {
            match rx.recv().await {
                Some(Envelope::ExitCodeNotification(n)) => {
                    exits_seen.insert(n.session_id);
                }
                Some(_) => {}
                None => return,
            }
        }
    })
    .await;

    assert_eq!(
        exits_seen.len(),
        N,
        "observed only {observed}/{N} ExitCodeNotifications within the 10 s budget — \
         either the waiter task is not firing for every spawn (separate bug) or the \
         envelope-drain loop is starved",
        observed = exits_seen.len()
    );

    // The waiter's `map.remove(&id)` happens-after the
    // `ExitCodeNotification` send (within microseconds in practice but
    // the two operations are independent). Poll briefly so the test
    // isn't flaky on slow CI; 2 s upper bound matches the lifecycle
    // grace window used by `active_session_count_tracks_lifecycle`.
    for _ in 0..40 {
        if registry.active_session_count().await == 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let final_count = registry.active_session_count().await;
    panic!(
        "registry leaked sessions: active_session_count() = {final_count} after every \
         one of {N} fast-exit ExitCodeNotifications was observed. This indicates the \
         spawn/exit lifecycle contract is broken — see `PtySessionRegistry::spawn` for \
         the insert-before-spawn shape that closes the race the bug introduces."
    );
}

/// Contract test for Plan-024 §Implementation Step 5 ordering: every
/// `DataFrame` written by the child must arrive on the outbound
/// channel BEFORE the `ExitCodeNotification` for the same session.
///
/// The pre-fix waiter emitted `ExitCodeNotification` immediately after
/// `Child::wait()` returned, without waiting for the reader pump to
/// observe PTY EOF. On a child that wrote substantial output and then
/// exited, the waiter could overtake the reader's final chunk(s) —
/// the consumer would see `ExitCodeNotification` before some trailing
/// bytes the child wrote, violating the protocol ordering contract.
///
/// The fix awaits the reader task's `JoinHandle` (with a 500 ms
/// timeout) inside the waiter, so the notification cannot fire until
/// either:
///   (a) the reader has read every byte the child wrote and observed
///       PTY EOF, or
///   (b) the drain timeout elapses (in which case the reader is
///       aborted — Phase 1 prefers forward progress on the exit
///       notification over an unbounded wait).
///
/// ## Scope and limits — macOS vs Windows
///
/// On macOS + Linux PTY the writer and reader operate in lockstep
/// through a small kernel buffer (~16 KiB on Darwin), so by the time
/// `printf` finishes and the child exits, the reader has already
/// consumed every byte. `Child::wait()` returns AFTER the reader has
/// already drained the master-side buffer, leaving no trailing
/// chunks for the waiter to overtake. Empirically this test passes
/// on macOS even with the drain removed — the race is structurally
/// possible but not observable through real PTY timing on Darwin.
///
/// The bug is much more readily observable on **Windows ConPTY**,
/// where the master-side EOF can lag the child exit by tens of
/// milliseconds (ConPTY buffers stdout through a separate kernel
/// pipe with its own flush latency). On Windows the pre-fix shape
/// would reliably emit `ExitCodeNotification` before the reader
/// drained, producing the protocol violation. Phase 3 T-024-3-1
/// brings the Windows test surface up, at which point this test
/// (compiled and run on Windows) will be the load-bearing bite for
/// the race. On macOS + Linux it is a positive-coverage contract
/// pin: the byte-total assertion + last-envelope assertion together
/// document and lock in the post-fix ordering invariant.
///
/// ## Why 256 KiB / 32 chunks
///
/// 32 chunks of 8 KiB each (`READ_CHUNK_BYTES`) gives the reader
/// substantial work and exercises the multi-DataFrame ordering path
/// alongside the single-chunk smoke. `drain_until_exit` returns on
/// the first `ExitCodeNotification` it sees, so if the notification
/// arrived early on a system whose PTY behavior permits the race,
/// the collected byte total would fall short of 256 KiB — that's
/// the test's bite.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn exit_notification_arrives_after_final_data_frame() {
    let (registry, mut rx) = PtySessionRegistry::new();

    // 256 KiB of 'A' (32 × 8 KiB chunks) followed by `exit 0`. Each
    // `printf 'A%.0s' $(seq ...)` emits exactly 'A' once per seq arg
    // — portable on macOS + Linux + (in MSYS-like) Windows shells.
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

    // Drain envelopes until the first `ExitCodeNotification`. With the
    // drain in place the reader pumps every chunk before that
    // notification can fire.
    let envelopes = drain_until_exit(&mut rx).await;

    // Load-bearing assertion: the ExitCodeNotification arrives LAST.
    // Without the waiter's drain this would not hold for substantial
    // output even when the test happens to win the race in CI — the
    // shape pre-fix had no happens-before edge from reader-drain to
    // notification-emit.
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

    // Load-bearing assertion: ALL 256 KiB of 'A' bytes arrived before
    // the notification. `drain_until_exit` returns on the FIRST
    // notification it sees, so if a chunk arrives AFTER the
    // notification it never enters `envelopes` — the byte total
    // would fall short. Counting bytes directly catches that.
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
        data_total, PAYLOAD_BYTES,
        "expected all {PAYLOAD_BYTES} bytes of 'A' before ExitCodeNotification, got \
         data_total={data_total} (envelopes={count}). A shortfall indicates the waiter \
         fired ExitCodeNotification before the reader finished pumping — see \
         `READER_DRAIN_TIMEOUT` + `spawn_waiter_task` for the drain shape that pins \
         this ordering.",
        count = envelopes.len()
    );

    // Exactly one ExitCodeNotification, carrying the spawned id and
    // exit_code 0 (printf + exit 0 → 0).
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
