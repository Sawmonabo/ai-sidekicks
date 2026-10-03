//! Helpers shared by the integration tests that spawn real children through the registry.

use std::time::Duration;

use sidecar_rust_pty::protocol::{DataStream, Envelope};
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::time::timeout;

/// Budget for a child to exit and its `ExitCodeNotification` to arrive; the children finish in
/// milliseconds, so 2 s only fails fast on a hang.
const EXIT_TIMEOUT: Duration = Duration::from_secs(2);

/// Collects envelopes from `rx` until an `ExitCodeNotification` arrives or `EXIT_TIMEOUT` elapses,
/// so tests can assert ordering without busy-waiting.
pub async fn drain_until_exit(rx: &mut UnboundedReceiver<Envelope>) -> Vec<Envelope> {
    let mut envelopes = Vec::new();
    let _ = timeout(EXIT_TIMEOUT, async {
        while let Some(envelope) = rx.recv().await {
            let is_exit = matches!(envelope, Envelope::ExitCodeNotification(_));
            envelopes.push(envelope);
            if is_exit {
                return;
            }
        }
    })
    .await;
    envelopes
}

/// An empty environment; the spawns under test need none.
pub fn empty_env() -> Vec<(String, String)> {
    Vec::new()
}

/// Asserts what a child that prints `hello` and exits 0 produces: stdout `DataFrame`s for the
/// session whose bytes contain `hello`, then exactly one `ExitCodeNotification`, last, with exit
/// code 0 and no signal code.
#[track_caller]
pub fn assert_hello_then_clean_exit(envelopes: &[Envelope], session_id: &str) {
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
    // The PTY may translate LF to CRLF, so assert `contains` rather than equality.
    let mut combined: Vec<u8> = Vec::new();
    for df in &data_frames {
        combined.extend_from_slice(&df.bytes);
    }
    let combined_str = String::from_utf8_lossy(&combined);
    assert!(
        combined_str.contains("hello"),
        "stdout payload should contain 'hello', got: {combined_str:?}"
    );

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
    assert_eq!(exit.exit_code, 0, "the child's exit code 0 propagates");
    assert_eq!(exit.signal_code, None, "signal_code is None for every exit");
}
