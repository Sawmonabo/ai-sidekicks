//! Sidecar runtime — Plan-024 Phase 3 dispatcher binary.
//!
//! ## What this binary does
//!
//! The sidecar is a stdio-driven PTY multiplexer. It reads
//! Content-Length-framed JSON envelopes from stdin, dispatches each by
//! its `kind` discriminant to the [`pty_session::PtySessionRegistry`],
//! and writes responses (plus async [`DataFrame`] / [`ExitCodeNotification`]
//! events) back through Content-Length-framed stdout.
//!
//! Single-process, single-thread-of-control on the dispatch arm; reader
//! and waiter background tasks per session feed an `mpsc` channel that
//! the dispatcher drains alongside its inbound poll. No retries, no
//! backoff, no respawn — that is the daemon's concern (see
//! `packages/runtime-daemon/src/pty/rust-sidecar-pty-host.ts` for the
//! supervisor side; this binary stays a pure stdio actor).
//!
//! ## Wire shape
//!
//! Inbound (daemon → sidecar): one of
//! `SpawnRequest`, `ResizeRequest`, `WriteRequest`, `KillRequest`,
//! `PingRequest` per [`crate::protocol::Envelope`]. Any other inbound
//! variant is a contract violation (the daemon must not echo response /
//! notification kinds back at the sidecar) and is logged + skipped — we
//! do not abort the dispatcher because that would tear down every
//! active session for one malformed message.
//!
//! Outbound (sidecar → daemon): the matching `*Response` for each
//! request kind, plus async `DataFrame` and `ExitCodeNotification`
//! variants pushed by the per-session reader / waiter tasks.
//!
//! ## Concurrency
//!
//! Two `tokio` tasks at the top level:
//!   1. Inbound dispatch loop — read frames from stdin, hand each to
//!      the appropriate `registry.<kind>(...)` async method, push the
//!      response onto the outbound channel.
//!   2. Outbound writer loop — drain the outbound `mpsc::Receiver` and
//!      write each envelope through `framing::write_frame` to stdout.
//!
//! Splitting the writer means a slow `taskkill` (or a stuck reader pump)
//! cannot stall stdin processing; the inbound loop keeps draining
//! requests while the writer queues.
//!
//! `tokio::select!` is NOT used between read_frame and writer-drain —
//! `framing::read_frame` is documented as NOT cancel-safe. We run the
//! reader as a long-lived task and let the writer task own its own
//! select.
//!
//! ## Termination
//!
//! Stdin EOF is the only termination signal — when the daemon closes
//! its end of the pipe, `read_frame` returns `UnexpectedEof` and the
//! dispatcher returns cleanly. The writer task drains any final
//! outbound messages then exits when the registry's outbound sender
//! drops (i.e., when all session reader/waiter tasks have completed
//! AND the dispatcher's clone has been dropped).
//!
//! Refs: Plan-024 §Implementation Step 3 + 4 + 5 (dispatcher contract);
//! ADR-009 (Content-Length framing); ADR-019 §Decision item 1.

mod framing;
mod protocol;
mod pty_session;

// Windows-only translation/tree-kill substrate for Plan-024 I-024-1
// + I-024-2 + I-024-3. Module-level `#![cfg(target_os = "windows")]`
// gates inside each file ensure they compile out of the build on
// non-Windows targets without per-symbol attributes here.
//
// `allow(dead_code)` because the wire-through PR (T-024-3-1
// follow-up) is what reads from these modules inside
// `pty_session::kill()`. T-024-3-1 ships the substrate; the wire-
// through happens after the sidecar's Windows kill arm replaces its
// `WindowsKillNotImplemented` stub. Without this allow the
// module-level cargo build on Windows would warn-as-error on the
// unused public API.
#[cfg(target_os = "windows")]
#[allow(dead_code)]
mod kill_translation;
#[cfg(target_os = "windows")]
#[allow(dead_code)]
mod tree_kill;
#[cfg(target_os = "windows")]
#[allow(dead_code)]
mod wsl_pass_through;

use std::io::{Error as IoError, ErrorKind};

use tokio::io::{AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use crate::framing::{read_frame, write_frame};
use crate::protocol::{Envelope, KillResponse, ResizeResponse, SpawnResponse, WriteResponse};
use crate::pty_session::{PtySessionError, PtySessionRegistry};

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let (registry, outbound_rx) = PtySessionRegistry::new();

    // Dedicated channel for dispatcher-originated responses (Spawn,
    // Resize, Write, Kill, Ping replies + diagnostic envelopes for
    // failed requests). Kept distinct from the registry's outbound
    // channel so the dispatcher does not need a reference to the
    // registry's `Sender` (which is private to the registry's
    // internals via the `mpsc` channel returned from `new()`).
    //
    // Both channels feed the writer task (see `merge_to_writer` below).
    let (dispatch_tx, dispatch_rx) = mpsc::unbounded_channel::<Envelope>();

    // Writer task — drain both channels onto stdout.
    //
    // Owns stdout exclusively; the inbound + dispatcher arms can never
    // race on partial-frame bytes. The merge order is "whichever
    // channel has a message first" via `tokio::select!` between the
    // two recv futures, which is cancel-safe per the
    // `mpsc::UnboundedReceiver::recv` docs.
    let writer_handle = tokio::spawn(merge_to_writer(outbound_rx, dispatch_rx));

    // Dispatcher loop — block on stdin frame parse, dispatch, push
    // response onto the dispatch channel.
    let dispatch_result = run_dispatcher(&registry, dispatch_tx).await;

    // Drop the registry so its internal outbound sender's last clone
    // disappears once the per-session tasks finish. The writer task
    // observes `recv()` returning `None` on both channels and exits.
    drop(registry);

    // Wait for the writer to drain. If it errored (stdout closed, or
    // the writer task panicked), we surface that — see
    // `finalize_result` for the precedence contract.
    let writer_result = writer_handle.await.unwrap_or_else(|join_err| {
        Err(IoError::other(format!(
            "writer task join failed: {join_err}"
        )))
    });

    finalize_result(dispatch_result, writer_result)
}

/// Inbound dispatcher loop.
///
/// Reads Content-Length frames from stdin, parses as [`Envelope`],
/// dispatches by `kind`, pushes the response onto `dispatch_tx`. Returns
/// `Ok(())` on a clean stdin EOF (the daemon closed its end of the
/// pipe) and `Err` on any other I/O / parse error.
///
/// `framing::read_frame` is NOT cancel-safe (see its rustdoc), so this
/// loop drives every read to completion. The writer task is the only
/// concurrency partner; it never preempts a frame read.
///
/// ## Error handling philosophy
///
/// - Stdin EOF (`UnexpectedEof`) → return `Ok(())` — clean shutdown.
/// - Other stdin I/O error → return `Err` — process exits non-zero.
/// - Frame body that fails to deserialize as [`Envelope`] → log to
///   stderr and skip the frame. We do NOT tear down the dispatcher
///   for one malformed envelope because that would terminate every
///   active session. If the daemon is consistently sending malformed
///   data the operator sees the per-frame log line; the recovery is
///   theirs to drive.
/// - A request for an unknown / non-existent session → push the
///   appropriate per-kind error response onto `dispatch_tx` so the
///   daemon learns about the failure synchronously.
/// - Inbound variants that should never be inbound (Response /
///   Notification / DataFrame kinds) → log + skip. Same rationale as
///   the deserialize failure above.
async fn run_dispatcher(
    registry: &PtySessionRegistry,
    dispatch_tx: mpsc::UnboundedSender<Envelope>,
) -> std::io::Result<()> {
    let stdin = tokio::io::stdin();
    let mut reader = BufReader::new(stdin);

    loop {
        let body = match read_frame(&mut reader).await {
            Ok(body) => body,
            Err(e) if e.kind() == ErrorKind::UnexpectedEof => {
                // Daemon closed stdin. Clean shutdown.
                return Ok(());
            }
            Err(e) => {
                // Real I/O error or framing-level violation. We do not
                // try to recover — desync on a Content-Length stream
                // is unrecoverable (we cannot tell where the next
                // frame starts without re-syncing on a header line,
                // and the daemon's framer cannot be assumed to
                // re-sync either). Surface and exit.
                return Err(e);
            }
        };

        let envelope: Envelope = match serde_json::from_slice(&body) {
            Ok(env) => env,
            Err(parse_err) => {
                // Deserialize failed — most likely an unknown `kind`
                // or a malformed payload. Per the docstring above,
                // log + skip rather than tear down. The frame itself
                // was well-formed (read_frame returned the body); it
                // is only the JSON decode that failed.
                eprintln!(
                    "sidecar dispatcher: failed to deserialize Envelope ({parse_err}); skipping frame"
                );
                continue;
            }
        };

        dispatch_one(registry, envelope, &dispatch_tx).await?;
    }
}

/// Dispatch a single inbound envelope.
///
/// Pattern-matches on the envelope's variant; routes to the registry's
/// matching async method; constructs the appropriate response envelope
/// (or the appropriate diagnostic envelope on error); pushes onto the
/// outbound dispatch channel.
///
/// Variants that are never legitimately inbound (responses,
/// notifications, `DataFrame`) are logged + skipped — see
/// `run_dispatcher` rustdoc.
///
/// ## Return contract
///
/// Returns `Ok(())` when the response was successfully queued,
/// `Err(BrokenPipe)` when the outbound dispatch channel has closed
/// (writer task died — fatal pipeline failure, propagate up to
/// `main`).
///
/// Per-request errors (`UnknownSession`, kill failures, etc.) are
/// intentionally NOT process-level: they map to typed error responses
/// on the wire (e.g., `SpawnResponse { error: Some(...) }`) so a
/// single bad request does NOT tear down every other active session.
/// Only channel-closed errors propagate, because if the writer is
/// dead the dispatcher has nowhere to send any future response anyway.
async fn dispatch_one(
    registry: &PtySessionRegistry,
    envelope: Envelope,
    dispatch_tx: &mpsc::UnboundedSender<Envelope>,
) -> std::io::Result<()> {
    match envelope {
        Envelope::SpawnRequest(req) => {
            match registry.spawn(req).await {
                Ok(resp) => {
                    try_send_envelope(dispatch_tx, Envelope::SpawnResponse(resp))?;
                }
                Err(err) => {
                    // Symmetric extension of the resize/write/kill
                    // error path: a failed spawn handler MUST emit a
                    // typed error response so the daemon's awaiting
                    // Promise resolves promptly rather than hanging
                    // indefinitely. The daemon's `sendRequest` has no
                    // per-request timeout — only sync-throw on
                    // stdin.write or eventual rejection on child-exit
                    // — so without a wire-side rejection the Promise
                    // would sit in `outstanding` forever for any
                    // spawn against an alive, healthy sidecar whose
                    // command turns out to be nonexistent or
                    // non-executable. Diagnostic eprintln remains for
                    // operator-side log triage. `session_id` is empty
                    // because no session was minted; the daemon
                    // supervisor's `resolveOutstanding` rejects
                    // BEFORE registering tracking on the empty id
                    // (see `rust-sidecar-pty-host.ts::spawn`).
                    log_dispatch_error("spawn", &err);
                    try_send_envelope(
                        dispatch_tx,
                        Envelope::SpawnResponse(SpawnResponse {
                            session_id: String::new(),
                            error: Some(err.to_string()),
                        }),
                    )?;
                }
            }
        }
        Envelope::ResizeRequest(req) => {
            // Capture the session id before the move so we can include
            // it in both the typed error response and the eprintln on
            // failure.
            let sid = req.session_id.clone();
            match registry.resize(req).await {
                Ok(resp) => {
                    try_send_envelope(dispatch_tx, Envelope::ResizeResponse(resp))?;
                }
                Err(err) => {
                    // Per `KillResponse` rustdoc: a failed handler MUST
                    // emit a typed error response so the daemon's
                    // awaiting Promise resolves promptly rather than
                    // hanging indefinitely. Diagnostic eprintln remains
                    // for operator-side log triage.
                    log_dispatch_error_for_session("resize", &sid, &err);
                    try_send_envelope(
                        dispatch_tx,
                        Envelope::ResizeResponse(ResizeResponse {
                            session_id: sid,
                            error: Some(err.to_string()),
                        }),
                    )?;
                }
            }
        }
        Envelope::WriteRequest(req) => {
            let sid = req.session_id.clone();
            match registry.write(req).await {
                Ok(resp) => {
                    try_send_envelope(dispatch_tx, Envelope::WriteResponse(resp))?;
                }
                Err(err) => {
                    log_dispatch_error_for_session("write", &sid, &err);
                    try_send_envelope(
                        dispatch_tx,
                        Envelope::WriteResponse(WriteResponse {
                            session_id: sid,
                            error: Some(err.to_string()),
                        }),
                    )?;
                }
            }
        }
        Envelope::KillRequest(req) => {
            let sid = req.session_id.clone();
            match registry.kill(req).await {
                Ok(resp) => {
                    try_send_envelope(dispatch_tx, Envelope::KillResponse(resp))?;
                }
                Err(err) => {
                    log_dispatch_error_for_session("kill", &sid, &err);
                    try_send_envelope(
                        dispatch_tx,
                        Envelope::KillResponse(KillResponse {
                            session_id: sid,
                            error: Some(err.to_string()),
                        }),
                    )?;
                }
            }
        }
        Envelope::PingRequest(_) => {
            // Liveness probe — push an empty PingResponse. The
            // dispatcher does not consult the registry; ping is
            // load-bearing as a daemon-side health check (the
            // sidecar binary is alive AND its dispatcher loop is
            // making forward progress).
            try_send_envelope(
                dispatch_tx,
                Envelope::PingResponse(crate::protocol::PingResponse {}),
            )?;
        }
        // Variants that should never be inbound — daemon → sidecar
        // is request-only at this layer. Log + skip per the
        // run_dispatcher rustdoc.
        Envelope::SpawnResponse(_)
        | Envelope::ResizeResponse(_)
        | Envelope::WriteResponse(_)
        | Envelope::KillResponse(_)
        | Envelope::ExitCodeNotification(_)
        | Envelope::PingResponse(_)
        | Envelope::DataFrame(_) => {
            eprintln!(
                "sidecar dispatcher: unexpected inbound envelope kind ({}); skipping",
                envelope_kind_label(&envelope)
            );
        }
    }
    Ok(())
}

/// Outbound writer — drain `outbound_rx` (registry-pushed events) AND
/// `dispatch_rx` (dispatcher-pushed responses) onto stdout, one frame
/// per envelope.
///
/// The two-channel merge uses `tokio::select!` because both
/// `mpsc::UnboundedReceiver::recv` futures are documented cancel-safe.
/// Either channel closing causes its arm to return `None` permanently
/// — we exit when BOTH are closed.
///
/// Stdout writes are serialized by virtue of being inside a single
/// task — `framing::write_frame` is documented as not cancel-safe and
/// not internally synchronized; running the writer in one task is the
/// minimum-overhead synchronization.
///
/// ## Why drain both channels rather than a single merged channel?
///
/// The registry owns its outbound `Sender` and we cannot attach the
/// dispatcher's responses to it without reaching into private state.
/// A merged channel would require either:
///   - A shared `Sender` exposed from `PtySessionRegistry::new` (would
///     leak the channel choice into the public API).
///   - A pump task that forwards from both into a third channel
///     (extra task, extra clone overhead).
///
/// The two-channel select is the simplest shape and stays cancel-safe.
async fn merge_to_writer(
    outbound_rx: mpsc::UnboundedReceiver<Envelope>,
    dispatch_rx: mpsc::UnboundedReceiver<Envelope>,
) -> std::io::Result<()> {
    let mut stdout = tokio::io::stdout();
    write_merged(&mut stdout, outbound_rx, dispatch_rx).await
}

/// Generic writer-loop body extracted from [`merge_to_writer`] so a
/// regression test can drive it against an in-memory buffer instead
/// of `tokio::io::stdout()`. Keeping the production binding
/// `merge_to_writer(...)` unchanged means callers in `main()` are
/// undisturbed; the only purpose of this seam is testability for the
/// P1 dispatcher-writer-spin regression.
///
/// ## Why the if-guard pattern, not the original `continue`
///
/// The previous shape was:
///
/// ```ignore
/// tokio::select! {
///     biased;
///     msg = dispatch_rx.recv() => msg,
///     msg = outbound_rx.recv() => msg,
/// }
/// ```
///
/// with a `continue` after observing `None` on one branch while the
/// other was still open. Under `biased;` the dispatch arm is polled
/// first; once `dispatch_rx` closes it permanently returns `None`
/// immediately on every poll. The loop then hot-spins on
/// `dispatch_rx.recv() -> None -> continue -> dispatch_rx.recv() -> ...`
/// and never reaches the outbound arm — so queued `DataFrame` /
/// `ExitCodeNotification` envelopes are stranded and `main()` can
/// hang waiting on `writer_handle`.
///
/// The fix disables the closed arm via `tokio::select!`'s
/// per-branch `if` guard (per the `tokio::select!` rustdoc — a
/// false-valued guard makes the branch ineligible, so the random/biased
/// poll order skips it entirely). The bias is still load-bearing while
/// both channels are open: dispatcher responses still beat
/// registry-pushed events to stdout so the daemon's request-correlation
/// latency stays bounded by dispatch+ack rather than queue depth.
async fn write_merged<W>(
    writer: &mut W,
    mut outbound_rx: mpsc::UnboundedReceiver<Envelope>,
    mut dispatch_rx: mpsc::UnboundedReceiver<Envelope>,
) -> std::io::Result<()>
where
    W: AsyncWriteExt + Unpin,
{
    // Track which channel has observed permanent closure. Once an
    // observation has been made the corresponding branch is disabled
    // via the `if` guard below so `biased;` does not re-poll a closed
    // receiver. Tokio's `mpsc::UnboundedReceiver::recv` returns `None`
    // permanently after the channel closes; the `is_closed()` /
    // `None`-observation combination is sufficient to gate the branch.
    let mut dispatch_closed = false;
    let mut outbound_closed = false;

    loop {
        // Both channels closed: drain any straggler messages still
        // queued in the receivers' internal buffers, then exit. `recv`
        // returns `None` once the buffer is also empty, but `try_recv`
        // gives us a synchronous, allocation-free drain. This belt-and-
        // braces drain matches the previous behavior — under the
        // previous `continue` loop, a final select would have picked
        // these up before observing the second `None`.
        if dispatch_closed && outbound_closed {
            while let Ok(msg) = dispatch_rx.try_recv() {
                write_envelope(writer, msg).await?;
            }
            while let Ok(msg) = outbound_rx.try_recv() {
                write_envelope(writer, msg).await?;
            }
            return Ok(());
        }

        let next: Option<Envelope> = tokio::select! {
            // Bias the order so dispatcher responses are not starved
            // by a high-volume DataFrame stream from the registry.
            // Per `tokio::select!` rustdoc: `biased;` removes the
            // random branch shuffle. We want responses to flush
            // promptly so the daemon's request-correlation latency
            // stays bounded by the dispatch+ack round-trip rather
            // than queue depth.
            //
            // The `if` guards on each arm disable a branch whose
            // receiver has already returned `None`; without them the
            // bias would hot-spin on the closed arm and starve the
            // still-open one (the dispatcher-writer-spin regression).
            biased;
            msg = dispatch_rx.recv(), if !dispatch_closed => msg,
            msg = outbound_rx.recv(), if !outbound_closed => msg,
        };

        let Some(envelope) = next else {
            // The select picked a branch whose `recv` returned `None`
            // — that channel is permanently closed. Mark it so the
            // next iteration's guard disables the branch. The bias
            // remains in effect for the still-open channel until it
            // closes too.
            if !dispatch_closed && dispatch_rx.is_closed() {
                dispatch_closed = true;
            }
            if !outbound_closed && outbound_rx.is_closed() {
                outbound_closed = true;
            }
            continue;
        };

        write_envelope(writer, envelope).await?;
    }
}

/// Serialize one [`Envelope`] to JSON, frame with Content-Length, and
/// write to `stdout`.
///
/// Bubbles up serialization or I/O errors to the writer-task caller.
/// Per `framing::write_frame` cancel-safety guidance, this function
/// drives the entire write to completion before returning.
async fn write_envelope<W>(stdout: &mut W, envelope: Envelope) -> std::io::Result<()>
where
    W: AsyncWriteExt + Unpin,
{
    let body = serde_json::to_vec(&envelope).map_err(|e| {
        IoError::other(format!("failed to serialize Envelope to JSON: {e}"))
    })?;
    write_frame(stdout, &body).await
}

/// Render an [`Envelope`] variant to its `kind`-style label for log
/// lines. Mirrors the `#[serde(rename_all = "snake_case")]` attribute
/// on the enum so log output matches what an operator would see in a
/// trace of the wire format.
fn envelope_kind_label(envelope: &Envelope) -> &'static str {
    match envelope {
        Envelope::SpawnRequest(_) => "spawn_request",
        Envelope::SpawnResponse(_) => "spawn_response",
        Envelope::ResizeRequest(_) => "resize_request",
        Envelope::ResizeResponse(_) => "resize_response",
        Envelope::WriteRequest(_) => "write_request",
        Envelope::WriteResponse(_) => "write_response",
        Envelope::KillRequest(_) => "kill_request",
        Envelope::KillResponse(_) => "kill_response",
        Envelope::ExitCodeNotification(_) => "exit_code_notification",
        Envelope::PingRequest(_) => "ping_request",
        Envelope::PingResponse(_) => "ping_response",
        Envelope::DataFrame(_) => "data_frame",
    }
}

/// Log a dispatch error that has no associated session id (e.g., spawn
/// failure where the session id was never minted).
fn log_dispatch_error(operation: &str, err: &PtySessionError) {
    eprintln!("sidecar dispatcher: {operation} failed: {err}");
}

/// Log a dispatch error with the session id the request targeted.
fn log_dispatch_error_for_session(operation: &str, session_id: &str, err: &PtySessionError) {
    eprintln!(
        "sidecar dispatcher: {operation} failed for session_id={session_id:?}: {err}"
    );
}

/// Reconcile dispatcher and writer task results into a single process
/// exit status.
///
/// Dispatcher errors win because they're the most actionable
/// diagnostic for the operator (a stdin parse error or unrecoverable
/// framing-desync needs operator triage right now). Writer errors are
/// surfaced (not dropped) when the dispatcher exited cleanly —
/// stdout-closed-early or a writer-task panic must NOT be hidden
/// behind a "dispatcher returned `Ok`" check, or the sidecar exits 0
/// while its outbound pipeline is silently broken.
fn finalize_result(
    dispatch: std::io::Result<()>,
    writer: std::io::Result<()>,
) -> std::io::Result<()> {
    match (dispatch, writer) {
        (Err(e), _) => Err(e),
        (Ok(()), Err(e)) => Err(e),
        (Ok(()), Ok(())) => Ok(()),
    }
}

/// Send an envelope on the dispatch channel, converting a closed-
/// receiver `SendError` into a process-level `BrokenPipe`.
///
/// The receiver only closes when the writer task has dropped its
/// `mpsc::UnboundedReceiver` — i.e., the writer task has panicked or
/// exited. Continuing to push frames into a dead channel is silent
/// data loss (every subsequent `dispatch_one` response vanishes into
/// `/dev/null` until stdin EOF), so callers `?`-propagate this error
/// up to `main()` and the dispatcher loop tears down promptly.
///
/// Name mirrors the sibling `write_envelope` helper. It is *not*
/// named `send_or_abort` — abort is the caller's responsibility via
/// `?`-propagation, not this helper's.
fn try_send_envelope(
    tx: &mpsc::UnboundedSender<Envelope>,
    envelope: Envelope,
) -> std::io::Result<()> {
    tx.send(envelope).map_err(|send_err| {
        IoError::new(
            ErrorKind::BrokenPipe,
            format!("dispatch channel closed (writer task died): {send_err}"),
        )
    })
}

// ============================================================================
// Regression tests — inline because `write_merged` is private to the binary
// crate and exposing it via `lib.rs` would broaden the public surface for
// what is purely a writer-task internal seam. Co-locating the test next to
// the function it covers also keeps the diagnostic (P1 regression: dispatcher
// writer hot-spins when one channel closes) within shouting distance of the
// fix.
// ============================================================================
#[cfg(test)]
mod tests {
    use super::*;

    use std::pin::Pin;
    use std::sync::{Arc, Mutex};
    use std::task::{Context, Poll};
    use std::time::Duration;

    use crate::protocol::{DataFrame, DataStream, PingResponse};
    use tokio::io::AsyncWrite;
    use tokio::time::timeout;

    /// `AsyncWrite` adapter that appends bytes to a shared `Vec<u8>` so
    /// a regression test can inspect partial writer progress from the
    /// outside of the writer task without consuming the buffer.
    ///
    /// Distinguishing-from-`Vec`-directly is required by the P1
    /// discriminator test (`write_merged_drains_outbound_while_dispatch_closed_and_outbound_still_open`)
    /// because that test inspects what the writer has produced while
    /// the writer is still running. With a plain `&mut Vec<u8>` you
    /// cannot peek without ending the borrow; the `Arc<Mutex<...>>`
    /// indirection makes the buffer readable from a sibling task.
    struct SharedBufWriter {
        inner: Arc<Mutex<Vec<u8>>>,
    }

    impl AsyncWrite for SharedBufWriter {
        fn poll_write(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            self.inner.lock().unwrap().extend_from_slice(buf);
            Poll::Ready(Ok(buf.len()))
        }
        fn poll_flush(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
        fn poll_shutdown(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    // ------------------------------------------------------------------
    // `finalize_result` precedence tests — guard the contract that the
    // dispatcher's exit status is the most actionable diagnostic for
    // the operator, and that writer-side errors are NEVER silently
    // dropped just because the dispatcher returned `Ok`.
    // ------------------------------------------------------------------

    #[test]
    fn finalize_result_dispatcher_error_wins_over_writer_error() {
        let result = finalize_result(
            Err(IoError::new(ErrorKind::Other, "dispatcher boom")),
            Err(IoError::new(ErrorKind::Other, "writer boom")),
        );
        let err = result.expect_err("expected dispatcher Err");
        assert!(err.to_string().contains("dispatcher"), "got: {err}");
    }

    #[test]
    fn finalize_result_dispatcher_error_wins_over_writer_ok() {
        let result = finalize_result(
            Err(IoError::new(ErrorKind::Other, "dispatcher boom")),
            Ok(()),
        );
        let err = result.expect_err("expected dispatcher Err");
        assert!(err.to_string().contains("dispatcher"), "got: {err}");
    }

    #[test]
    fn finalize_result_surfaces_writer_error_when_dispatcher_ok() {
        let result = finalize_result(
            Ok(()),
            Err(IoError::new(ErrorKind::BrokenPipe, "writer boom")),
        );
        let err = result.expect_err(
            "regression: writer error must NOT be silently dropped when dispatcher returns Ok",
        );
        assert_eq!(err.kind(), ErrorKind::BrokenPipe);
    }

    #[test]
    fn finalize_result_ok_when_both_ok() {
        finalize_result(Ok(()), Ok(())).expect("both-ok must return Ok");
    }

    // ------------------------------------------------------------------
    // `try_send_envelope` — closed-receiver path must surface as
    // `BrokenPipe` so the dispatcher loop bails out instead of
    // silently dropping every subsequent response.
    // ------------------------------------------------------------------

    #[test]
    fn try_send_envelope_returns_broken_pipe_when_receiver_dropped() {
        let (tx, rx) = mpsc::unbounded_channel::<Envelope>();
        drop(rx);
        let err = try_send_envelope(&tx, Envelope::PingResponse(PingResponse {}))
            .expect_err("expected BrokenPipe after receiver dropped");
        assert_eq!(err.kind(), ErrorKind::BrokenPipe);
    }

    /// Smoke: after both channels close with a single queued envelope
    /// on outbound, the final `try_recv` drain delivers it and the
    /// loop exits cleanly. NOTE: this test does NOT discriminate the
    /// regression — under the broken spin code, both-closed is also
    /// reached (because Tokio's cooperative budget yields and lets the
    /// drop()s be observed); the `try_recv` drain at exit catches the
    /// queued envelope. Kept as a happy-path sanity check; the
    /// discriminator is the `_while_dispatch_closed_and_outbound_still_open`
    /// test below.
    #[tokio::test(flavor = "current_thread")]
    async fn write_merged_drains_buffered_outbound_when_both_channels_already_closed() {
        let (outbound_tx, outbound_rx) = mpsc::unbounded_channel::<Envelope>();
        let (dispatch_tx, dispatch_rx) = mpsc::unbounded_channel::<Envelope>();

        outbound_tx
            .send(Envelope::PingResponse(PingResponse {}))
            .expect("outbound send should succeed");
        drop(dispatch_tx);
        drop(outbound_tx);

        let mut buf: Vec<u8> = Vec::new();
        let result = timeout(
            Duration::from_millis(100),
            write_merged(&mut buf, outbound_rx, dispatch_rx),
        )
        .await;

        result
            .expect("write_merged did not exit within 100ms after both channels closed")
            .expect("write_merged returned an I/O error to the in-memory buffer");
        assert!(
            std::str::from_utf8(&buf)
                .map(|s| s.contains("\"ping_response\""))
                .unwrap_or(false),
            "writer output did not include the queued PingResponse envelope: {:?}",
            String::from_utf8_lossy(&buf)
        );
    }

    /// P1 regression discriminator: when `dispatch_rx` closes while
    /// `outbound_rx` is STILL OPEN and has a queued envelope, the
    /// writer MUST drain that envelope DURING the lifetime of
    /// `outbound_tx` — not at exit via the both-closed `try_recv`
    /// drain branch.
    ///
    /// This is what the broken `biased; + continue;` code cannot do:
    /// it hot-spins on `dispatch_rx.recv() -> None -> continue` and
    /// never polls outbound. Tokio's cooperative budget keeps the
    /// task scheduled (no true hang under tokio's runtime), but the
    /// queued envelope is stranded until either:
    ///   (a) outbound_rx ALSO closes — at which point the try_recv
    ///       drain catches it. Bypasses this test by keeping
    ///       outbound_tx alive past the assertion window.
    ///   (b) the spin runs forever — never reached because we keep
    ///       sender alive only until after the assertion.
    ///
    /// Under the FIX: `dispatch_closed` flips to true on the first
    /// `None` observation; the `if !dispatch_closed` guard disables
    /// the dispatch arm; the next iteration polls outbound_rx; the
    /// envelope is drained.
    ///
    /// We wait 20ms in real wall time before the assertion. The broken
    /// code's spin yields via Tokio's cooperative budget on each
    /// `recv() -> None`, so the runtime alternates between the writer
    /// (busy-spinning) and the test driver (in `sleep(20ms)`). The
    /// 20ms is empirical headroom — orders of magnitude larger than
    /// the single-poll loop iteration cost — but FAR shorter than the
    /// 100ms outer timeout that catches a true hang. (`start_paused`
    /// would make this deterministic but requires tokio's `test-util`
    /// feature, which lives in `Cargo.toml` and is outside this fix's
    /// `target_paths`.)
    #[tokio::test(flavor = "current_thread")]
    async fn write_merged_drains_outbound_while_dispatch_closed_and_outbound_still_open() {
        let (outbound_tx, outbound_rx) = mpsc::unbounded_channel::<Envelope>();
        let (dispatch_tx, dispatch_rx) = mpsc::unbounded_channel::<Envelope>();

        // Precondition: dispatch closed, outbound has a queued frame,
        // outbound_tx INTENTIONALLY kept alive.
        drop(dispatch_tx);
        outbound_tx
            .send(Envelope::DataFrame(DataFrame {
                session_id: "s-test".to_string(),
                stream: DataStream::Stdout,
                seq: 0,
                bytes: Vec::new(),
            }))
            .expect("outbound send should succeed");

        let shared = Arc::new(Mutex::new(Vec::<u8>::new()));
        let shared_for_writer = shared.clone();

        let writer = tokio::spawn(async move {
            let mut w = SharedBufWriter {
                inner: shared_for_writer,
            };
            write_merged(&mut w, outbound_rx, dispatch_rx).await
        });

        // Let the writer run. Under FIX: drains outbound on iter 2
        // (after dispatch_closed = true is set on iter 1). Under BUG:
        // hot-spins on closed dispatch_rx and never polls outbound;
        // outbound_tx is still alive so the both-closed exit branch
        // is unreachable.
        tokio::time::sleep(Duration::from_millis(20)).await;

        // Discriminating assertion: the DataFrame MUST be in the
        // buffer BEFORE we drop outbound_tx. The broken code's
        // try_recv-on-exit drain cannot help here because the exit
        // branch is gated on `outbound_closed && dispatch_closed` —
        // and outbound is still open at this point.
        {
            let snap = shared.lock().unwrap();
            assert!(
                std::str::from_utf8(&snap)
                    .map(|s| s.contains("\"data_frame\""))
                    .unwrap_or(false),
                "DataFrame was not drained while outbound_tx was alive (P1 regression: \
                 writer hot-spun on closed dispatch_rx instead of polling outbound_rx). \
                 Buffer contents: {:?}",
                String::from_utf8_lossy(&snap),
            );
        }

        // Now close outbound — the writer must reach the both-closed
        // exit branch and the task must finish.
        drop(outbound_tx);
        let join_result = timeout(Duration::from_millis(100), writer)
            .await
            .expect("writer did not exit within 100ms after outbound_tx drop");
        join_result
            .expect("writer task panicked")
            .expect("write_merged returned an I/O error to the in-memory buffer");
    }
}
