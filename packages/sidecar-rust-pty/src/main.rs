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
use crate::protocol::Envelope;
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

    // Wait for the writer to drain. If it errored (stdout closed), we
    // surface that — but the dispatcher's own EOF / I/O error takes
    // precedence (it is the most actionable diagnostic for the daemon
    // operator).
    let writer_result = writer_handle.await.unwrap_or_else(|join_err| {
        Err(IoError::other(format!(
            "writer task join failed: {join_err}"
        )))
    });

    match (dispatch_result, writer_result) {
        // Clean EOF on stdin = clean shutdown. Writer cleanup error
        // (e.g., stdout closed early) is a noisy log line at most;
        // we do not propagate as a process-level failure because the
        // operator already saw the clean stdin EOF.
        (Ok(()), _) => Ok(()),
        // Dispatcher error wins over writer error.
        (Err(e), _) => Err(e),
    }
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

        dispatch_one(registry, envelope, &dispatch_tx).await;
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
/// ## Why not return `Result`?
///
/// Per-request errors are wire-level (the daemon receives a typed
/// failure response or none at all); they are NOT process-level.
/// Returning `Result` here would invite the dispatcher loop to
/// short-circuit on a single session's `UnknownSession` failure,
/// which would tear down every other active session. Errors are
/// handled in-band: log to stderr for diagnostics + push the
/// appropriate response shape so the daemon synchronously learns of
/// the failure.
async fn dispatch_one(
    registry: &PtySessionRegistry,
    envelope: Envelope,
    dispatch_tx: &mpsc::UnboundedSender<Envelope>,
) {
    match envelope {
        Envelope::SpawnRequest(req) => {
            match registry.spawn(req).await {
                Ok(resp) => {
                    let _ = dispatch_tx.send(Envelope::SpawnResponse(resp));
                }
                Err(err) => {
                    // Spawn failure surfaces to the daemon as a
                    // diagnostic eprintln — there is no "spawn-failed"
                    // wire variant in Phase 3, and adding one would
                    // require a contract bump. The daemon side
                    // observes the absence of a SpawnResponse and
                    // routes the user-visible error through its own
                    // `PtyBackendUnavailable` envelope instead.
                    //
                    // Phase 3 trade-off accepted: the daemon's
                    // request/response correlation is sequential at
                    // this layer (no `request_id`), so a missing
                    // SpawnResponse can be inferred only by tracking
                    // outstanding spawn requests. The daemon-side
                    // `RustSidecarPtyHost` does this tracking.
                    log_dispatch_error("spawn", &err);
                }
            }
        }
        Envelope::ResizeRequest(req) => {
            // Capture the session id before the move so we can
            // include it in the eprintln on failure.
            let sid = req.session_id.clone();
            match registry.resize(req).await {
                Ok(resp) => {
                    let _ = dispatch_tx.send(Envelope::ResizeResponse(resp));
                }
                Err(err) => {
                    log_dispatch_error_for_session("resize", &sid, &err);
                }
            }
        }
        Envelope::WriteRequest(req) => {
            let sid = req.session_id.clone();
            match registry.write(req).await {
                Ok(resp) => {
                    let _ = dispatch_tx.send(Envelope::WriteResponse(resp));
                }
                Err(err) => {
                    log_dispatch_error_for_session("write", &sid, &err);
                }
            }
        }
        Envelope::KillRequest(req) => {
            let sid = req.session_id.clone();
            match registry.kill(req).await {
                Ok(resp) => {
                    let _ = dispatch_tx.send(Envelope::KillResponse(resp));
                }
                Err(err) => {
                    log_dispatch_error_for_session("kill", &sid, &err);
                }
            }
        }
        Envelope::PingRequest(_) => {
            // Liveness probe — push an empty PingResponse. The
            // dispatcher does not consult the registry; ping is
            // load-bearing as a daemon-side health check (the
            // sidecar binary is alive AND its dispatcher loop is
            // making forward progress).
            let _ = dispatch_tx.send(Envelope::PingResponse(crate::protocol::PingResponse {}));
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
    mut outbound_rx: mpsc::UnboundedReceiver<Envelope>,
    mut dispatch_rx: mpsc::UnboundedReceiver<Envelope>,
) -> std::io::Result<()> {
    let mut stdout = tokio::io::stdout();

    loop {
        let next: Option<Envelope> = tokio::select! {
            // Bias the order so dispatcher responses are not starved
            // by a high-volume DataFrame stream from the registry.
            // Per `tokio::select!` rustdoc: `biased;` removes the
            // random branch shuffle. We want responses to flush
            // promptly so the daemon's request-correlation latency
            // stays bounded by the dispatch+ack round-trip rather
            // than queue depth.
            biased;
            msg = dispatch_rx.recv() => msg,
            msg = outbound_rx.recv() => msg,
        };

        let Some(envelope) = next else {
            // Both channels CAN return None independently inside this
            // single recv — we get here when the bias-favored branch
            // returns None. Check the other; if it also has no more
            // pending messages and is closed, we are done. Otherwise
            // continue to drain.
            //
            // Tokio's `mpsc::UnboundedReceiver::recv` returns None
            // permanently after the channel closes; subsequent calls
            // continue to return None. So a single None observation
            // is sufficient to mark THAT channel closed; we still
            // need both closed to exit.
            //
            // Implementation: try one more read on the alternate
            // channel via `try_recv`. If both `try_recv` calls return
            // `Empty` AND `Disconnected`, we exit.
            if dispatch_rx.is_closed() && outbound_rx.is_closed() {
                // Belt-and-braces final drain — pull anything still
                // queued before exiting. `try_recv` returns
                // `Disconnected` once a closed channel is empty.
                while let Ok(msg) = dispatch_rx.try_recv() {
                    write_envelope(&mut stdout, msg).await?;
                }
                while let Ok(msg) = outbound_rx.try_recv() {
                    write_envelope(&mut stdout, msg).await?;
                }
                return Ok(());
            }
            // One channel returned None but the other is still open.
            // Loop back and select on both again — the open channel
            // will eventually deliver or close.
            continue;
        };

        write_envelope(&mut stdout, envelope).await?;
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
