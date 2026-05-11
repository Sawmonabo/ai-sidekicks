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
/// Matches the 1 KiB header cap enforced by the TS sibling framer at
/// `packages/runtime-daemon/src/ipc/local-ipc-gateway.ts` so a malicious or
/// buggy peer cannot OOM the sidecar by streaming an unterminated header
/// (e.g., `Content-Type: AAAAA…` for gigabytes). The sidecar's trust
/// boundary includes the child process on the other side of stdio, so this
/// cap is load-bearing.
const MAX_HEADER_LINE_BYTES: usize = 1024;

/// Header name used for content length (case-insensitive on read).
const CONTENT_LENGTH_HEADER: &str = "content-length";

/// Read one Content-Length-framed frame from `reader`. Returns the body bytes.
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
/// - The stream closes before the empty CRLF that terminates the header block
/// - The stream closes mid-body (declared length exceeds bytes available;
///   surfaced by [`AsyncReadExt::read_exact`])
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
pub async fn read_frame<R>(reader: &mut R) -> std::io::Result<Vec<u8>>
where
    R: AsyncBufReadExt + Unpin,
{
    let mut content_length: Option<usize> = None;
    let mut line = String::new();

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
            // EOF before header block terminator
            return Err(Error::new(
                ErrorKind::UnexpectedEof,
                "EOF before end of header block",
            ));
        }

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
    reader.read_exact(&mut body).await?;
    Ok(body)
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
