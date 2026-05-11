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
/// Per F-024-1-06. Matches ADR-009's `--max-old-space-size` rationale for the
/// equivalent TS framing layer. Larger payloads should be chunked at the
/// protocol layer (e.g., DataFrame chunking at 8 KiB stdout/stderr blocks).
pub const MAX_FRAME_BODY_BYTES: usize = 8 * 1024 * 1024;

/// Header name used for content length (case-insensitive on read).
const CONTENT_LENGTH_HEADER: &str = "content-length";

/// Read one Content-Length-framed frame from `reader`. Returns the body bytes.
///
/// Errors with `ErrorKind::InvalidData` if:
/// - Missing Content-Length header
/// - Content-Length value is not a valid usize
/// - Content-Length exceeds [`MAX_FRAME_BODY_BYTES`]
/// - A header line is malformed (no `:` separator, or not `\r\n`-terminated)
/// - EOF is reached mid-header
pub async fn read_frame<R>(reader: &mut R) -> std::io::Result<Vec<u8>>
where
    R: AsyncBufReadExt + Unpin,
{
    let mut content_length: Option<usize> = None;
    let mut line = String::new();

    loop {
        line.clear();
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            // EOF before header block terminator
            return Err(Error::new(
                ErrorKind::UnexpectedEof,
                "EOF before end of header block",
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
/// Emits `Content-Length: {body.len()}\r\n\r\n<body>` and flushes. Returns
/// `ErrorKind::InvalidData` if `body.len() > MAX_FRAME_BODY_BYTES` so the
/// write side enforces the same cap as the read side.
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
