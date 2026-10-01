//! Sidecar dispatcher binary: a stdio-driven PTY multiplexer.
//!
//! It reads Content-Length-framed JSON [`crate::protocol::Envelope`]s from stdin, dispatches each
//! by `kind` to the [`pty_session::PtySessionRegistry`], and writes responses plus async
//! `DataFrame` and `ExitCodeNotification` events to stdout. Retries, backoff and respawn belong to
//! the daemon (`packages/runtime-daemon/src/pty/rust-sidecar-pty-host.ts`); this binary stays a
//! pure stdio actor.
//!
//! ## Wire shape
//!
//! Inbound are `SpawnRequest`, `ResizeRequest`, `WriteRequest`, `KillRequest` and `PingRequest`.
//! Any other inbound variant is a peer contract violation; it is logged and skipped, not fatal,
//! because it cannot mis-correlate a request and aborting would kill every active session. Outbound
//! is the matching `*Response` per request plus the async `DataFrame` and `ExitCodeNotification`
//! events from the per-session tasks.
//!
//! ## Concurrency
//!
//! A writer task owns stdout and drains two channels: the registry's events and the dispatcher's
//! responses. The dispatcher loop reads stdin on the main task, so a slow output pump cannot stall
//! stdin. `framing::read_frame` is not cancel-safe, so it is never a `select!` arm.
//!
//! ## Termination
//!
//! Stdin EOF at a frame boundary is the only graceful shutdown: `read_frame` returns
//! [`FrameReadOutcome::CleanEof`], the dispatcher returns `Ok(())`, and the writer drains and exits
//! once every sender has dropped. EOF mid-frame is an `Err(UnexpectedEof)` and a non-zero exit, so
//! a truncated frame trips the supervisor's crash budget instead of exiting `0`.

mod framing;
mod protocol;
mod pty_session;

// Windows-only modules, each gated by a module-level `#![cfg(target_os = "windows")]`.
// `allow(dead_code)` because the Windows arm of `pty_session::kill()` does not call them yet.
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

use crate::framing::{read_frame, write_frame, FrameReadOutcome};
use crate::protocol::{Envelope, KillResponse, ResizeResponse, SpawnResponse, WriteResponse};
use crate::pty_session::{PtySessionError, PtySessionRegistry};

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let (registry, outbound_rx) = PtySessionRegistry::new();

    // Dispatcher responses use their own channel because the registry's sender is private to it.
    // The writer task merges both.
    let (dispatch_tx, dispatch_rx) = mpsc::unbounded_channel::<Envelope>();

    // The writer task owns stdout, so frames cannot interleave. `select!` between the two receivers
    // is cancel-safe.
    let writer_handle = tokio::spawn(merge_to_writer(outbound_rx, dispatch_rx));

    let dispatch_result = run_dispatcher(&registry, dispatch_tx).await;

    // Drop the registry so its last outbound sender goes once the session tasks finish; the writer
    // then sees both channels closed and exits.
    drop(registry);

    // Surface a writer failure (stdout closed or the task panicked); see `finalize_result`.
    let writer_result = writer_handle.await.unwrap_or_else(|join_err| {
        Err(IoError::other(format!(
            "writer task join failed: {join_err}"
        )))
    });

    finalize_result(dispatch_result, writer_result)
}

/// Reads frames from stdin, decodes each as an [`Envelope`], and dispatches it.
///
/// Returns `Ok(())` on a clean EOF at a frame boundary and `Err` on anything else. `read_frame` is
/// not cancel-safe, so every read runs to completion.
///
/// ## Errors and skips
///
/// - Mid-frame EOF returns `Err(UnexpectedEof)`, so the process exits non-zero and the supervisor's
///   crash budget trips.
/// - A framing violation (`InvalidData`) returns `Err`, because a Content-Length stream cannot
///   resync.
/// - A body that does not decode as an [`Envelope`] returns `Err(InvalidData)`. The daemon matches
///   responses by FIFO order per kind with no request ids, so skipping a malformed request would
///   leave its Promise unresolved or pair a later response with the wrong waiter.
/// - A request for an unknown session gets a per-kind error response.
/// - An inbound response, notification or `DataFrame` is logged and skipped: it is a peer contract
///   violation, but no Promise awaits it, so tearing down every session over it would be worse.
async fn run_dispatcher(
    registry: &PtySessionRegistry,
    dispatch_tx: mpsc::UnboundedSender<Envelope>,
) -> std::io::Result<()> {
    let stdin = tokio::io::stdin();
    let reader = BufReader::new(stdin);
    run_dispatcher_with_reader(reader, registry, dispatch_tx).await
}

/// The dispatcher loop over any buffered reader: [`run_dispatcher`] passes stdin, and tests pass an
/// in-memory frame stream so the fatal-decode path runs end to end.
async fn run_dispatcher_with_reader<R>(
    mut reader: R,
    registry: &PtySessionRegistry,
    dispatch_tx: mpsc::UnboundedSender<Envelope>,
) -> std::io::Result<()>
where
    R: tokio::io::AsyncBufRead + Unpin,
{
    loop {
        let body = match read_frame(&mut reader).await {
            Ok(FrameReadOutcome::Frame(body)) => body,
            Ok(FrameReadOutcome::CleanEof) => {
                return Ok(());
            }
            Err(e) => {
                // I/O error, framing violation or mid-frame EOF: the stream cannot resync, so exit
                // non-zero.
                return Err(e);
            }
        };

        let envelope: Envelope = match serde_json::from_slice(&body) {
            Ok(env) => env,
            Err(parse_err) => {
                // The frame was well formed but its JSON did not decode. Fatal, for the FIFO reason
                // on `run_dispatcher`.
                return Err(IoError::new(
                    ErrorKind::InvalidData,
                    format!(
                        "sidecar dispatcher: failed to deserialize Envelope ({parse_err}); \
                         aborting — daemon correlates responses by FIFO order with no request \
                         IDs, so silently skipping a malformed inbound frame would either leave \
                         the corresponding Promise unresolved or match a later response to the \
                         wrong waiter."
                    ),
                ));
            }
        };

        dispatch_one(registry, envelope, &dispatch_tx).await?;
    }
}

/// Dispatches one inbound envelope to the registry and queues the response on `dispatch_tx`.
///
/// Returns `Err(BrokenPipe)` only when the dispatch channel has closed (the writer died). A failed
/// request is not process-level: it becomes an `error` response, so one bad request cannot tear
/// down other sessions.
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
                    // A failed spawn still gets a response so the daemon's awaiting Promise rejects
                    // promptly instead of hanging. `session_id` is empty because no session was
                    // created; the daemon rejects before it registers tracking on that id.
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
            // Keep the id: the request moves into the registry call.
            let sid = req.session_id.clone();
            match registry.resize(req).await {
                Ok(resp) => {
                    try_send_envelope(dispatch_tx, Envelope::ResizeResponse(resp))?;
                }
                Err(err) => {
                    // A failed handler still gets a typed error response; the log line is for
                    // the person reading the logs.
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
            // Ping does not touch the registry; the reply shows the dispatcher loop is making
            // progress.
            try_send_envelope(
                dispatch_tx,
                Envelope::PingResponse(crate::protocol::PingResponse {}),
            )?;
        }
        // Responses and notifications are never legitimately inbound; log and skip.
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

/// Drains `outbound_rx` (registry events) and `dispatch_rx` (dispatcher responses) onto stdout, one
/// frame per envelope, until both are closed.
///
/// One task does all the writing because `write_frame` is neither cancel-safe nor internally
/// synchronized. Two receivers are used instead of one merged channel because the registry owns its
/// sender; sharing it would leak the channel into the registry's API or need an extra pump task.
async fn merge_to_writer(
    outbound_rx: mpsc::UnboundedReceiver<Envelope>,
    dispatch_rx: mpsc::UnboundedReceiver<Envelope>,
) -> std::io::Result<()> {
    let mut stdout = tokio::io::stdout();
    write_merged(&mut stdout, outbound_rx, dispatch_rx).await
}

/// The writer-loop body of [`merge_to_writer`], generic over the writer so tests can use an
/// in-memory buffer.
///
/// Two pitfalls shape the `select!`:
///
/// - A closed channel's `recv()` returns `Ready(None)` forever, so without an `if` guard per arm
///   the loop would spin on it and never reach the open channel.
/// - `biased;` would always poll `dispatch_rx` first, and under sustained requests the outbound
///   events (`DataFrame`, `ExitCodeNotification`) would starve. The default random arm order keeps
///   both fair.
async fn write_merged<W>(
    writer: &mut W,
    mut outbound_rx: mpsc::UnboundedReceiver<Envelope>,
    mut dispatch_rx: mpsc::UnboundedReceiver<Envelope>,
) -> std::io::Result<()>
where
    W: AsyncWriteExt + Unpin,
{
    // Set once a channel is seen closed; the `if` guard then disables its arm.
    let mut dispatch_closed = false;
    let mut outbound_closed = false;

    loop {
        // Both closed: write anything still buffered, then exit.
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
            // No `biased;`: the default random arm order keeps neither channel starved. The `if`
            // guards stop a closed arm from spinning.
            msg = dispatch_rx.recv(), if !dispatch_closed => msg,
            msg = outbound_rx.recv(), if !outbound_closed => msg,
        };

        let Some(envelope) = next else {
            // `None` means that channel closed; mark it so its arm is disabled from now on.
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

/// Serializes one [`Envelope`] to JSON and writes it as a frame; returns serialization or I/O
/// errors.
async fn write_envelope<W>(stdout: &mut W, envelope: Envelope) -> std::io::Result<()>
where
    W: AsyncWriteExt + Unpin,
{
    let body = serde_json::to_vec(&envelope)
        .map_err(|e| IoError::other(format!("failed to serialize Envelope to JSON: {e}")))?;
    write_frame(stdout, &body).await
}

/// Renders an [`Envelope`] variant as its snake_case `kind` label for log lines.
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

/// Logs a dispatch error that has no session id (the spawn never minted one).
fn log_dispatch_error(operation: &str, err: &PtySessionError) {
    eprintln!("sidecar dispatcher: {operation} failed: {err}");
}

/// Log a dispatch error with the session id the request targeted.
fn log_dispatch_error_for_session(operation: &str, session_id: &str, err: &PtySessionError) {
    eprintln!("sidecar dispatcher: {operation} failed for session_id={session_id:?}: {err}");
}

/// Merges the dispatcher and writer results into the process exit status.
///
/// A dispatcher error wins as the most actionable. A writer error is still surfaced when the
/// dispatcher exited cleanly, so a broken stdout never exits `0`.
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

/// Sends an envelope on the dispatch channel, turning a closed receiver into `BrokenPipe`.
///
/// The receiver closes only when the writer task has died; continuing would silently drop every
/// later response, so callers propagate this with `?`.
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

// Tests are inline because `write_merged` is private to the binary crate.
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

    /// `AsyncWrite` that appends to a shared buffer, so a test can inspect the writer's output
    /// while the writer task is still running.
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
        fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    // `finalize_result`: the dispatcher's error wins, and a writer error is never dropped when the
    // dispatcher returns `Ok`.

    #[test]
    fn finalize_result_dispatcher_error_wins() {
        for writer in [Err(IoError::other("writer boom")), Ok(())] {
            let result = finalize_result(Err(IoError::other("dispatcher boom")), writer);
            let err = result.expect_err("expected dispatcher Err");
            assert!(err.to_string().contains("dispatcher"), "got: {err}");
        }
    }

    #[test]
    fn finalize_result_surfaces_writer_error_when_dispatcher_ok() {
        let result = finalize_result(
            Ok(()),
            Err(IoError::new(ErrorKind::BrokenPipe, "writer boom")),
        );
        let err =
            result.expect_err("a writer error must not be dropped when the dispatcher returns Ok");
        assert_eq!(err.kind(), ErrorKind::BrokenPipe);
    }

    // `try_send_envelope`: a closed receiver must surface as `BrokenPipe` so the dispatcher stops.

    #[test]
    fn try_send_envelope_returns_broken_pipe_when_receiver_dropped() {
        let (tx, rx) = mpsc::unbounded_channel::<Envelope>();
        drop(rx);
        let err = try_send_envelope(&tx, Envelope::PingResponse(PingResponse {}))
            .expect_err("expected BrokenPipe after receiver dropped");
        assert_eq!(err.kind(), ErrorKind::BrokenPipe);
    }

    /// Happy-path check: both channels closed with one queued envelope, and the final `try_recv`
    /// drain delivers it. It does not catch the closed-arm spin; the next test does.
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

    /// Guards against the closed-arm spin: with `dispatch_rx` closed and `outbound_rx` still
    /// open and holding an envelope, the writer must drain that envelope while `outbound_tx` is
    /// alive, not only at exit.
    ///
    /// The spinning shape (`biased;` plus `continue` on a closed arm) never polls outbound, so the
    /// envelope stays stranded until outbound also closes. The 20 ms wait is empirical headroom,
    /// well under the 100 ms outer timeout; `start_paused` would make it deterministic but needs
    /// tokio's `test-util` feature.
    #[tokio::test(flavor = "current_thread")]
    async fn write_merged_drains_outbound_while_dispatch_closed_and_outbound_still_open() {
        let (outbound_tx, outbound_rx) = mpsc::unbounded_channel::<Envelope>();
        let (dispatch_tx, dispatch_rx) = mpsc::unbounded_channel::<Envelope>();

        // Dispatch is closed; outbound holds a frame and its sender stays alive.
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

        tokio::time::sleep(Duration::from_millis(20)).await;

        // The frame must be in the buffer before `outbound_tx` drops.
        {
            let snap = shared.lock().unwrap();
            assert!(
                std::str::from_utf8(&snap)
                    .map(|s| s.contains("\"data_frame\""))
                    .unwrap_or(false),
                "DataFrame was not drained while outbound_tx was alive (the writer \
                 hot-spun on closed dispatch_rx instead of polling outbound_rx). \
                 Buffer contents: {:?}",
                String::from_utf8_lossy(&snap),
            );
        }

        // Close outbound so the writer reaches its exit branch.
        drop(outbound_tx);
        let join_result = timeout(Duration::from_millis(100), writer)
            .await
            .expect("writer did not exit within 100ms after outbound_tx drop");
        join_result
            .expect("writer task panicked")
            .expect("write_merged returned an I/O error to the in-memory buffer");
    }

    /// Decodes the Content-Length frames in a writer buffer, so a test can check where a frame
    /// appears in the output. Panics on malformed input, which would be a writer bug.
    fn parse_all_frames(buf: &[u8]) -> Vec<Envelope> {
        let mut frames = Vec::new();
        let mut cursor = 0usize;
        while cursor < buf.len() {
            // Header: `Content-Length: N\r\n\r\n`
            let header_end = (cursor..buf.len())
                .position(|i| buf.get(i..i + 4) == Some(b"\r\n\r\n"))
                .map(|rel_idx| cursor + rel_idx)
                .expect("frame header missing CRLFCRLF terminator");
            let header =
                std::str::from_utf8(&buf[cursor..header_end]).expect("header is not UTF-8");
            let len_str = header
                .strip_prefix("Content-Length: ")
                .expect("frame header missing 'Content-Length: ' prefix");
            let body_len: usize = len_str
                .parse()
                .expect("Content-Length value is not a usize");
            let body_start = header_end + 4;
            let body_end = body_start + body_len;
            assert!(
                body_end <= buf.len(),
                "frame body extends past buffer end (body_end={body_end}, buf.len()={})",
                buf.len()
            );
            let envelope: Envelope = serde_json::from_slice(&buf[body_start..body_end])
                .expect("frame body did not deserialize as Envelope");
            frames.push(envelope);
            cursor = body_end;
        }
        frames
    }

    /// Guards against live-channel starvation: while `dispatch_rx` stays continuously ready,
    /// a queued outbound `DataFrame` must still appear early in the output.
    ///
    /// With `biased;` the writer always picks dispatch, so the `DataFrame` would come after every
    /// queued ping (position 200 or more). With the default random order its position clusters near
    /// the start, so `< 50` is a safe threshold. A producer keeps dispatch saturated; without
    /// sustained pressure the dispatch queue would drain and the bug would not show.
    #[tokio::test(flavor = "current_thread")]
    async fn write_merged_does_not_starve_outbound_under_dispatch_pressure() {
        let (dispatch_tx, dispatch_rx) = mpsc::unbounded_channel::<Envelope>();
        let (outbound_tx, outbound_rx) = mpsc::unbounded_channel::<Envelope>();

        // Pre-fill dispatch so it is saturated when the writer starts.
        for _ in 0..200 {
            dispatch_tx
                .send(Envelope::PingResponse(PingResponse {}))
                .expect("dispatch pre-fill send should succeed");
        }
        outbound_tx
            .send(Envelope::DataFrame(DataFrame {
                session_id: "s-starvation".to_string(),
                stream: DataStream::Stdout,
                seq: 0,
                bytes: Vec::new(),
            }))
            .expect("outbound DataFrame send should succeed");

        let shared = Arc::new(Mutex::new(Vec::<u8>::new()));
        let shared_for_writer = shared.clone();
        let writer_handle = tokio::spawn(async move {
            let mut w = SharedBufWriter {
                inner: shared_for_writer,
            };
            write_merged(&mut w, outbound_rx, dispatch_rx).await
        });

        // Keeps `dispatch_rx` ready; the send fails once the writer drops the receiver.
        let producer = tokio::spawn(async move {
            loop {
                if dispatch_tx
                    .send(Envelope::PingResponse(PingResponse {}))
                    .is_err()
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        });

        // Let the writer run under sustained dispatch pressure.
        tokio::time::sleep(Duration::from_millis(50)).await;

        // Stop the producer and close outbound so the writer can exit.
        producer.abort();
        let _ = producer.await; // join the aborted task (ignore abort error)
        drop(outbound_tx);

        timeout(Duration::from_millis(200), writer_handle)
            .await
            .expect("writer did not exit within 200ms after teardown")
            .expect("writer task panicked")
            .expect("write_merged returned an I/O error to the in-memory buffer");

        let snap = shared.lock().unwrap();
        let frames = parse_all_frames(&snap);
        let data_pos = frames
            .iter()
            .position(|f| matches!(f, Envelope::DataFrame(_)))
            .expect("DataFrame missing from writer output");

        // Fair order puts the `DataFrame` in the first few frames; dispatch bias puts it after all
        // 200 pings.
        assert!(
            data_pos < 50,
            "DataFrame at position {data_pos}: live-channel starvation \
             (expected position < 50 under fair-shuffle; ~200+ under dispatch-bias). \
             Total frames written: {}.",
            frames.len()
        );
    }

    // A well-framed frame with an undecodable body must make `run_dispatcher_with_reader` return
    // `Err(InvalidData)` instead of skipping it. The daemon matches responses by FIFO order with no
    // request ids, so skipping would hang or cross-wire a Promise; failing trips the supervisor's
    // crash budget and the restart resets the FIFO state.

    /// Frames `body` the way `framing::write_frame` does, so the test needs no writer-side framer.
    fn build_framed(body: &[u8]) -> Vec<u8> {
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        let mut out = Vec::with_capacity(header.len() + body.len());
        out.extend_from_slice(header.as_bytes());
        out.extend_from_slice(body);
        out
    }

    /// A frame whose JSON fails to decode must surface `Err(InvalidData)`, so the process exits
    /// non-zero.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatcher_aborts_on_malformed_json_body() {
        // Unterminated JSON: the framer accepts the frame and only the decode fails.
        let body = br#"{"kind": "spawn_request""#;
        let framed = build_framed(body);
        let reader = BufReader::new(&framed[..]);

        let (registry, _outbound_rx) = PtySessionRegistry::new();
        let (dispatch_tx, _dispatch_rx) = mpsc::unbounded_channel::<Envelope>();

        let result = timeout(
            Duration::from_millis(100),
            run_dispatcher_with_reader(reader, &registry, dispatch_tx),
        )
        .await
        .expect("dispatcher did not return within 100ms of receiving malformed frame");

        let err = result.expect_err(
            "a malformed JSON body must be fatal — \
             daemon correlates responses by FIFO order with no request \
             IDs, so silently skipping a malformed inbound frame would \
             either leave the corresponding Promise unresolved or match \
             a later response to the wrong waiter.",
        );
        assert_eq!(
            err.kind(),
            ErrorKind::InvalidData,
            "expected InvalidData (fatal transport corruption); got kind {:?} with message: {err}",
            err.kind()
        );
        // Substring match: the `serde_json` context reaches the diagnostic without pinning its
        // exact wording.
        let msg = err.to_string();
        assert!(
            msg.contains("deserialize") && msg.contains("Envelope"),
            "diagnostic missing 'deserialize' / 'Envelope' substrings; got: {msg}"
        );
    }
}
