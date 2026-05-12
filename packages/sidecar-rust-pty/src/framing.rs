//! LSP-style Content-Length framing (per ADR-009).
//!
//! Wire format: `Content-Length: N\r\n\r\n<N bytes of body>`. Optional
//! additional headers (e.g., Content-Type) are accepted on read but
//! ignored — only Content-Length is load-bearing.
//!
//! Plan-024 Phase 1 / T-024-1-2.

use std::io::{Error, ErrorKind};

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

/// Maximum frame body size (8 MiB).
///
/// Per F-024-1-06 (Plan-024 §Target Areas). ADR-009 §Decision does not pin a
/// numeric cap; the 8 MiB ceiling is Plan-024 policy chosen to accommodate
/// `DataFrame` chunking at 8 KiB stdout/stderr boundaries (per Plan-024
/// §Implementation Step 4) with two-and-a-half orders of magnitude of
/// headroom for control-message envelopes. Larger payloads MUST be chunked
/// at the protocol layer.
pub const MAX_FRAME_BODY_BYTES: usize = 8 * 1024 * 1024;

/// Maximum bytes per header line, including the trailing `\r\n`.
///
/// Numerically matches the 1 KiB header cap in the TS sibling framer at
/// `packages/runtime-daemon/src/ipc/local-ipc-gateway.ts` (see the
/// `separatorIndex` / `buffer.byteLength` checks around lines 275/283), but
/// enforced PER-LINE here vs PER-SECTION there. Per-line is stricter against
/// single-giant-line OOM (the threat this constant addresses — e.g.,
/// `Content-Type: AAAAA…` for gigabytes); per-section is stricter against
/// many-short-header CPU/handle pinning, which is mitigated at a higher
/// layer via idle-peer timeouts. The sidecar's trust boundary includes the
/// child process on the other side of stdio, so this cap is load-bearing.
const MAX_HEADER_LINE_BYTES: usize = 1024;

/// Header name used for content length (case-insensitive on read).
const CONTENT_LENGTH_HEADER: &str = "content-length";

/// Outcome of a single [`read_frame`] call.
///
/// Two **clean** returns:
///   - [`FrameReadOutcome::Frame`] — a complete Content-Length frame was
///     read and its body bytes are returned.
///   - [`FrameReadOutcome::CleanEof`] — the stream closed at a frame
///     boundary BEFORE any bytes were consumed for the next frame. This
///     is the "daemon closed stdin during normal shutdown" signal — the
///     dispatcher maps it to a graceful `Ok(())` exit.
///
/// All other failure modes surface as `Err(io::Error)` (see [`read_frame`]
/// errors). The distinction matters because conflating "clean shutdown"
/// with "protocol corruption that looked like clean shutdown" lets
/// truncated-frame regressions exit `0` and hide from the supervisor's
/// crash-budget diagnostics. A truncated `Content-Length` body, a
/// partial header line, or any other mid-frame EOF MUST surface as an
/// `Err` so the supervisor's crash budget trips and the operator sees
/// a framing-fault log line.
#[derive(Debug)]
pub enum FrameReadOutcome {
    /// One complete Content-Length frame; payload is the body bytes.
    Frame(Vec<u8>),
    /// Stream closed at a frame boundary — no bytes consumed for the
    /// would-be next frame. Graceful shutdown signal.
    CleanEof,
}

/// Read one Content-Length-framed frame from `reader`.
///
/// Returns [`FrameReadOutcome::Frame`] with the body bytes on a complete
/// frame, [`FrameReadOutcome::CleanEof`] when the stream closes at a
/// frame boundary (no bytes consumed for the next frame), or an
/// `io::Error` for any other terminal condition.
///
/// # Errors
///
/// Returns `ErrorKind::InvalidData` if:
/// - A header line is malformed (no `:` separator, or not `\r\n`-terminated)
/// - A header line exceeds [`MAX_HEADER_LINE_BYTES`]
/// - The Content-Length header is missing from the block
/// - The Content-Length value is not a valid `usize`
/// - The Content-Length header appears more than once (request-smuggling
///   shape; matches the TS sibling framer's strict-grammar contract)
/// - The declared body length exceeds [`MAX_FRAME_BODY_BYTES`]
///
/// Returns `ErrorKind::UnexpectedEof` if:
/// - The stream closes AFTER any bytes have been consumed for the
///   current frame but BEFORE the empty CRLF that terminates the header
///   block (mid-header truncation)
/// - The stream closes mid-body (declared length exceeds bytes available;
///   surfaced by [`AsyncReadExt::read_exact`])
///
/// **A clean EOF at the frame boundary (before ANY header bytes have
/// been consumed for this frame) is NOT an error** — it returns
/// [`FrameReadOutcome::CleanEof`]. This is the load-bearing distinction
/// the dispatcher uses to differentiate graceful daemon shutdown from
/// transport corruption.
///
/// # Cancel safety
///
/// `read_frame` is **NOT** cancel-safe. It composes [`AsyncBufReadExt::read_line`]
/// (per-line header parsing) with [`AsyncReadExt::read_exact`] (body read),
/// neither of which is cancel-safe per the Tokio documentation. Dropping
/// the future mid-call leaves partial state in the underlying `BufReader`
/// (and the in-progress body `Vec<u8>`) and will desync every subsequent
/// frame. Callers MUST drive this future to completion; do NOT use it as
/// the cancellable arm of `tokio::select!`. Implement cancellation via a
/// separate signal checked between frames, not mid-frame.
pub async fn read_frame<R>(reader: &mut R) -> std::io::Result<FrameReadOutcome>
where
    R: AsyncBufReadExt + Unpin,
{
    let mut content_length: Option<usize> = None;
    let mut line = String::new();
    // True until the first byte of THIS frame's header block has been
    // consumed. A zero-byte `read_line` while still `true` means the
    // stream closed cleanly at a frame boundary — graceful shutdown.
    // A zero-byte `read_line` while `false` means we have already
    // started consuming this frame's bytes and the close is a mid-
    // header truncation — surface as `UnexpectedEof`.
    let mut at_frame_boundary = true;

    loop {
        line.clear();
        // Bound the per-line read so a peer cannot OOM us with an
        // unterminated header. `Take` caps at MAX_HEADER_LINE_BYTES + 1 so
        // a line whose total length (including its CRLF) equals the cap
        // can complete, while one byte over the cap leaves `line.len()`
        // strictly greater than the cap and we reject explicitly below.
        let n = {
            let mut limited = (&mut *reader).take((MAX_HEADER_LINE_BYTES + 1) as u64);
            limited.read_line(&mut line).await?
        };
        if n == 0 {
            // EOF on a header-line read. Two shapes:
            if at_frame_boundary {
                // Clean shutdown at frame boundary — no header bytes
                // consumed for this frame. The dispatcher maps this
                // to a graceful `Ok(())` exit.
                return Ok(FrameReadOutcome::CleanEof);
            }
            // We have already consumed bytes for this frame's header
            // block (a prior `read_line` returned `n > 0`); a zero-byte
            // return now means the stream closed mid-header. This is
            // transport corruption — surface to the supervisor.
            return Err(Error::new(
                ErrorKind::UnexpectedEof,
                "EOF mid-header-block before frame complete",
            ));
        }
        // Bytes consumed for THIS frame — any subsequent EOF on this
        // frame is mid-frame truncation, not a clean boundary close.
        // Flip BEFORE the CRLF / cap validation arms below so even an
        // immediate rejection path (e.g., InvalidData from a malformed
        // first line) has already committed to "not at boundary".
        at_frame_boundary = false;

        if line.len() > MAX_HEADER_LINE_BYTES {
            return Err(Error::new(
                ErrorKind::InvalidData,
                format!("header line exceeds MAX_HEADER_LINE_BYTES ({MAX_HEADER_LINE_BYTES})"),
            ));
        }

        // Each header line MUST end with \r\n per LSP/ADR-009. read_line stops
        // at \n; verify the preceding byte is \r and strip the CRLF.
        if !line.ends_with("\r\n") {
            return Err(Error::new(
                ErrorKind::InvalidData,
                "header line not terminated by CRLF",
            ));
        }
        let stripped = &line[..line.len() - 2];

        if stripped.is_empty() {
            // Empty line terminates the header block.
            break;
        }

        let (name, value) = stripped.split_once(':').ok_or_else(|| {
            Error::new(ErrorKind::InvalidData, "header line missing ':' separator")
        })?;

        // LSP allows case variation on header names.
        if name.trim().eq_ignore_ascii_case(CONTENT_LENGTH_HEADER) {
            // Reject duplicate Content-Length headers per the strict-grammar
            // contract enforced by the TS sibling framer
            // (packages/runtime-daemon/src/ipc/local-ipc-gateway.ts ~line 411).
            // A peer sending two Content-Length headers is the request-
            // smuggling shape — silently last-wins would let the parser slice
            // a body of one length from a buffer carrying the other, leaving
            // the remainder to be reinterpreted as a fresh frame. Refuse at
            // the boundary.
            if content_length.is_some() {
                return Err(Error::new(
                    ErrorKind::InvalidData,
                    "duplicate Content-Length header (request-smuggling shape)",
                ));
            }
            let parsed: usize = value.trim().parse().map_err(|_| {
                Error::new(
                    ErrorKind::InvalidData,
                    "Content-Length value is not a valid usize",
                )
            })?;
            content_length = Some(parsed);
        }
        // Other headers (e.g., Content-Type) are accepted and ignored.
    }

    let len = content_length
        .ok_or_else(|| Error::new(ErrorKind::InvalidData, "missing Content-Length header"))?;

    if len > MAX_FRAME_BODY_BYTES {
        return Err(Error::new(
            ErrorKind::InvalidData,
            format!("frame body {len} bytes exceeds MAX_FRAME_BODY_BYTES ({MAX_FRAME_BODY_BYTES})"),
        ));
    }

    let mut body = vec![0u8; len];
    // Wrap `read_exact`'s bare `UnexpectedEof` ("failed to fill whole
    // buffer") with declared-length context so the operator-visible
    // diagnostic matches the richness of the mid-header arm above.
    // The `ErrorKind` round-trips unchanged via `e.kind()` — the
    // dispatcher still routes this to `Err(e)` identically; only the
    // message string gains the `mid-body (declared N bytes)` framing
    // for the stderr log line.
    reader.read_exact(&mut body).await.map_err(|e| {
        Error::new(
            e.kind(),
            format!("EOF mid-body (declared {len} bytes): {e}"),
        )
    })?;
    Ok(FrameReadOutcome::Frame(body))
}

/// Write one Content-Length-framed frame to `writer`.
///
/// Emits `Content-Length: {body.len()}\r\n\r\n<body>` and flushes.
///
/// # Errors
///
/// Returns `ErrorKind::InvalidData` if `body.len() > MAX_FRAME_BODY_BYTES`,
/// so the write side enforces the same cap as the read side. Any underlying
/// I/O error from [`AsyncWriteExt::write_all`] or [`AsyncWriteExt::flush`]
/// is propagated unchanged.
///
/// # Cancel safety
///
/// `write_frame` is **NOT** cancel-safe. It performs two sequential
/// [`AsyncWriteExt::write_all`] calls plus a final [`AsyncWriteExt::flush`];
/// none of these is cancel-safe per the Tokio documentation. Dropping the
/// future after the header has been written but before the body completes
/// will emit a partial frame and desync the peer. See `read_frame` for the
/// cancellation guidance — drive every call to completion.
///
/// # Concurrency
///
/// `write_frame` is **NOT** internally synchronized. The two `write_all`
/// calls (header, then body) are sequential but not atomic; concurrent
/// calls on a shared writer will interleave bytes and corrupt the framed
/// stream. Callers MUST serialize writes — typically by holding a
/// `tokio::sync::Mutex<Writer>` across the full `write_frame(...)` call,
/// NOT just per `write_all`.
pub async fn write_frame<W>(writer: &mut W, body: &[u8]) -> std::io::Result<()>
where
    W: AsyncWriteExt + Unpin,
{
    if body.len() > MAX_FRAME_BODY_BYTES {
        return Err(Error::new(
            ErrorKind::InvalidData,
            format!(
                "frame body {} bytes exceeds MAX_FRAME_BODY_BYTES ({MAX_FRAME_BODY_BYTES})",
                body.len()
            ),
        ));
    }

    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    writer.write_all(header.as_bytes()).await?;
    writer.write_all(body).await?;
    writer.flush().await?;
    Ok(())
}
