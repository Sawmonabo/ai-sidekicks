//! Content-Length framing for the sidecar's stdio protocol.
//!
//! Wire format: `Content-Length: N\r\n\r\n<N bytes of body>`. Other headers are accepted on read
//! and ignored.

use std::io::{Error, ErrorKind};

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

/// Maximum frame body size (8 MiB); the protocol layer chunks larger payloads.
///
/// Far above the 8 KiB output chunk, so control envelopes always fit.
pub const MAX_FRAME_BODY_BYTES: usize = 8 * 1024 * 1024;

/// Maximum bytes per header line, including the trailing `\r\n`.
///
/// Stops a peer from exhausting memory with one unterminated header line. The daemon-side framer
/// caps the whole header section at the same 1 KiB instead.
const MAX_HEADER_LINE_BYTES: usize = 1024;

const CONTENT_LENGTH_HEADER: &str = "content-length";

/// Result of one [`read_frame`] call.
///
/// A clean EOF is how the daemon's normal shutdown looks. Any mid-frame EOF is an `Err`, so a
/// truncated frame trips the supervisor's crash budget instead of exiting `0`.
#[derive(Debug)]
pub enum FrameReadOutcome {
    /// One complete frame; the payload is the body bytes.
    Frame(Vec<u8>),
    /// The stream closed at a frame boundary, before any byte of the next frame.
    CleanEof,
}

/// Reads one Content-Length frame from `reader`.
///
/// # Errors
///
/// `ErrorKind::InvalidData` for a header line that has no `:` or is not CRLF-terminated, a header
/// line over `MAX_HEADER_LINE_BYTES`, a Content-Length that is missing, duplicated or not a
/// `usize`, or a body over [`MAX_FRAME_BODY_BYTES`]. `ErrorKind::UnexpectedEof` when the stream
/// closes mid-header or mid-body.
///
/// # Cancel safety
///
/// Not cancel-safe: `read_line` and `read_exact` are not, so dropping the future mid-call desyncs
/// every later frame. Drive it to completion; never make it a `tokio::select!` arm.
pub async fn read_frame<R>(reader: &mut R) -> std::io::Result<FrameReadOutcome>
where
    R: AsyncBufReadExt + Unpin,
{
    let mut content_length: Option<usize> = None;
    let mut line = String::new();
    // True until the first byte of this frame is read: EOF while true is a clean close, otherwise a
    // truncation.
    let mut at_frame_boundary = true;

    loop {
        line.clear();
        // The `Take` cap stops an unterminated header from exhausting memory. The `+ 1` lets a line
        // of exactly the cap (CRLF included) finish, while one byte more is rejected below.
        let n = {
            let mut limited = (&mut *reader).take((MAX_HEADER_LINE_BYTES + 1) as u64);
            limited.read_line(&mut line).await?
        };
        if n == 0 {
            if at_frame_boundary {
                return Ok(FrameReadOutcome::CleanEof);
            }
            // Bytes were already consumed for this frame, so the stream closed mid-header.
            return Err(Error::new(
                ErrorKind::UnexpectedEof,
                "EOF mid-header-block before frame complete",
            ));
        }
        // From here on, EOF is a mid-frame truncation.
        at_frame_boundary = false;

        if line.len() > MAX_HEADER_LINE_BYTES {
            return Err(Error::new(
                ErrorKind::InvalidData,
                format!("header line exceeds MAX_HEADER_LINE_BYTES ({MAX_HEADER_LINE_BYTES})"),
            ));
        }

        // A header line must end in `\r\n`; strip it.
        if !line.ends_with("\r\n") {
            return Err(Error::new(
                ErrorKind::InvalidData,
                "header line not terminated by CRLF",
            ));
        }
        let stripped = &line[..line.len() - 2];

        if stripped.is_empty() {
            break;
        }

        let (name, value) = stripped.split_once(':').ok_or_else(|| {
            Error::new(ErrorKind::InvalidData, "header line missing ':' separator")
        })?;

        // Header names are case-insensitive.
        if name.trim().eq_ignore_ascii_case(CONTENT_LENGTH_HEADER) {
            // A second Content-Length is the request-smuggling shape: last-wins would let the rest
            // of the body be read as a new frame. The daemon-side framer rejects it too.
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
    // Keep the error kind; add the declared length to the message for the stderr log.
    reader.read_exact(&mut body).await.map_err(|e| {
        Error::new(
            e.kind(),
            format!("EOF mid-body (declared {len} bytes): {e}"),
        )
    })?;
    Ok(FrameReadOutcome::Frame(body))
}

/// Writes one frame (`Content-Length: {len}\r\n\r\n<body>`) to `writer` and flushes.
///
/// # Errors
///
/// `ErrorKind::InvalidData` if the body exceeds [`MAX_FRAME_BODY_BYTES`]; I/O errors propagate
/// unchanged.
///
/// # Cancel safety
///
/// Not cancel-safe (a drop after the header leaves a partial frame) and not internally
/// synchronized: concurrent calls on a shared writer interleave. Hold one lock across the whole
/// call.
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
