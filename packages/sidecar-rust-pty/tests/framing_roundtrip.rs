//! Round-trip tests for the Content-Length framing layer: header edge cases, the 8 MiB cap, and
//! byte-identical write/read.

use std::io::ErrorKind;

use sidecar_rust_pty::framing::{read_frame, write_frame, FrameReadOutcome, MAX_FRAME_BODY_BYTES};
use tokio::io::BufReader;

/// Unwraps a [`FrameReadOutcome::Frame`], panicking on `CleanEof`.
fn expect_frame(outcome: FrameReadOutcome) -> Vec<u8> {
    match outcome {
        FrameReadOutcome::Frame(body) => body,
        FrameReadOutcome::CleanEof => {
            panic!("expected FrameReadOutcome::Frame, got CleanEof")
        }
    }
}

/// Writes `body` with `write_frame`, reads it back with `read_frame`, and returns the recovered
/// body.
async fn round_trip(body: &[u8]) -> Vec<u8> {
    let mut buf: Vec<u8> = Vec::new();
    write_frame(&mut buf, body)
        .await
        .expect("write_frame should succeed");

    let mut reader = BufReader::new(&buf[..]);
    let outcome = read_frame(&mut reader)
        .await
        .expect("read_frame should succeed");
    expect_frame(outcome)
}

#[tokio::test]
async fn round_trip_empty_body() {
    let body: &[u8] = &[];
    let recovered = round_trip(body).await;
    assert_eq!(recovered, body);
}

#[tokio::test]
async fn round_trip_small_body() {
    let body = b"hello world";
    let recovered = round_trip(body).await;
    assert_eq!(recovered, body);
}

#[tokio::test]
async fn round_trip_json_payload_with_embedded_newlines() {
    // Content-Length framing must survive newlines and CRLF inside the payload, which
    // newline-delimited JSON cannot.
    let body = b"{\"kind\":\"spawn\",\"args\":[\"line1\\nline2\\r\\nline3\"]}";
    let recovered = round_trip(body).await;
    assert_eq!(recovered, body);
}

#[tokio::test]
async fn round_trip_binary_payload_with_nulls_and_high_bytes() {
    let mut body = Vec::with_capacity(256);
    for i in 0u16..=255 {
        body.push(i as u8);
    }
    let recovered = round_trip(&body).await;
    assert_eq!(recovered, body);
}

#[tokio::test]
async fn round_trip_at_cap_succeeds() {
    // The cap is inclusive.
    let body = vec![0xABu8; MAX_FRAME_BODY_BYTES];
    let recovered = round_trip(&body).await;
    assert_eq!(recovered.len(), body.len());
    assert_eq!(recovered, body);
}

#[tokio::test]
async fn round_trip_near_cap_7_mib() {
    // Near but under the cap, with a non-trivial pattern.
    let size = 7 * 1024 * 1024;
    let body: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
    let recovered = round_trip(&body).await;
    assert_eq!(recovered.len(), body.len());
    assert_eq!(recovered, body);
}

#[tokio::test]
async fn write_rejects_over_cap_body() {
    // The write side enforces the same cap as the read side.
    let body = vec![0u8; MAX_FRAME_BODY_BYTES + 1];
    let mut buf: Vec<u8> = Vec::new();
    let err = write_frame(&mut buf, &body)
        .await
        .expect_err("write_frame should reject body > cap");
    assert_eq!(err.kind(), ErrorKind::InvalidData);
    let msg = format!("{err}");
    assert!(
        msg.contains("MAX_FRAME_BODY_BYTES"),
        "error message should reference the cap constant, got: {msg}"
    );
}

#[tokio::test]
async fn read_rejects_over_cap_body() {
    // The reader must reject before allocating the buffer or reading any body byte.
    let header = format!("Content-Length: {}\r\n\r\n", MAX_FRAME_BODY_BYTES + 1);
    let bytes = header.into_bytes();
    let mut reader = BufReader::new(&bytes[..]);
    let err = read_frame(&mut reader)
        .await
        .expect_err("read_frame should reject body > cap");
    assert_eq!(err.kind(), ErrorKind::InvalidData);
    let msg = format!("{err}");
    assert!(
        msg.contains("MAX_FRAME_BODY_BYTES"),
        "error message should reference the cap constant, got: {msg}"
    );
}

#[tokio::test]
async fn read_rejects_missing_content_length_header() {
    // An empty header block with no Content-Length is malformed.
    let bytes = b"\r\n".to_vec();
    let mut reader = BufReader::new(&bytes[..]);
    let err = read_frame(&mut reader)
        .await
        .expect_err("read_frame should reject missing Content-Length");
    assert_eq!(err.kind(), ErrorKind::InvalidData);
    let msg = format!("{err}");
    assert!(
        msg.contains("Content-Length"),
        "error message should mention the missing header, got: {msg}"
    );
}

#[tokio::test]
async fn read_rejects_non_numeric_content_length() {
    let bytes = b"Content-Length: not-a-number\r\n\r\n".to_vec();
    let mut reader = BufReader::new(&bytes[..]);
    let err = read_frame(&mut reader)
        .await
        .expect_err("read_frame should reject non-numeric Content-Length");
    assert_eq!(err.kind(), ErrorKind::InvalidData);
}

#[tokio::test]
async fn read_rejects_header_without_colon() {
    let bytes = b"Content-Length 5\r\n\r\nhello".to_vec();
    let mut reader = BufReader::new(&bytes[..]);
    let err = read_frame(&mut reader)
        .await
        .expect_err("read_frame should reject header missing ':'");
    assert_eq!(err.kind(), ErrorKind::InvalidData);
}

#[tokio::test]
async fn read_rejects_lf_only_header_terminator() {
    // A bare LF must be rejected, or non-conformant peers would be accepted silently.
    let bytes = b"Content-Length: 5\n\nhello".to_vec();
    let mut reader = BufReader::new(&bytes[..]);
    let err = read_frame(&mut reader)
        .await
        .expect_err("read_frame should reject LF-only line terminators");
    assert_eq!(err.kind(), ErrorKind::InvalidData);
}

#[tokio::test]
async fn read_accepts_case_insensitive_content_length() {
    // Header names are case-insensitive.
    let header = b"content-length: 5\r\n\r\n";
    let body = b"hello";
    let mut bytes = Vec::with_capacity(header.len() + body.len());
    bytes.extend_from_slice(header);
    bytes.extend_from_slice(body);
    let mut reader = BufReader::new(&bytes[..]);
    let recovered = expect_frame(
        read_frame(&mut reader)
            .await
            .expect("lowercase header should be accepted"),
    );
    assert_eq!(recovered, body);
}

#[tokio::test]
async fn read_accepts_extra_headers_and_ignores_them() {
    // Other headers such as Content-Type must be tolerated so such a peer is not dropped.
    let header = b"Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n\
                   Content-Length: 5\r\n\
                   \r\n";
    let body = b"hello";
    let mut bytes = Vec::with_capacity(header.len() + body.len());
    bytes.extend_from_slice(header);
    bytes.extend_from_slice(body);
    let mut reader = BufReader::new(&bytes[..]);
    let recovered = expect_frame(
        read_frame(&mut reader)
            .await
            .expect("auxiliary headers should be ignored, not rejected"),
    );
    assert_eq!(recovered, body);
}

#[tokio::test]
async fn read_rejects_eof_mid_header_block() {
    // The stream closes after a Content-Length line, before the empty CRLF that ends the header
    // block.
    let bytes = b"Content-Length: 5\r\n".to_vec();
    let mut reader = BufReader::new(&bytes[..]);
    let err = read_frame(&mut reader)
        .await
        .expect_err("read_frame should reject EOF inside header block");
    assert_eq!(err.kind(), ErrorKind::UnexpectedEof);
}

#[tokio::test]
async fn read_rejects_eof_mid_body() {
    // The header advertises 10 bytes and only 3 arrive; `read_exact` must surface the truncation.
    let mut bytes = b"Content-Length: 10\r\n\r\n".to_vec();
    bytes.extend_from_slice(b"abc");
    let mut reader = BufReader::new(&bytes[..]);
    let err = read_frame(&mut reader)
        .await
        .expect_err("read_frame should reject EOF inside body");
    assert_eq!(err.kind(), ErrorKind::UnexpectedEof);
}

#[tokio::test]
async fn read_two_back_to_back_frames() {
    // The reader must leave the buffer positioned correctly after each frame.
    let body_a = b"first frame";
    let body_b = b"second frame, slightly longer";
    let mut buf: Vec<u8> = Vec::new();
    write_frame(&mut buf, body_a).await.expect("write A");
    write_frame(&mut buf, body_b).await.expect("write B");

    let mut reader = BufReader::new(&buf[..]);
    let got_a = expect_frame(read_frame(&mut reader).await.expect("read A"));
    let got_b = expect_frame(read_frame(&mut reader).await.expect("read B"));
    assert_eq!(got_a, body_a);
    assert_eq!(got_b, body_b);
}

#[tokio::test]
async fn read_rejects_duplicate_content_length() {
    // Two Content-Length headers are the request-smuggling shape; the daemon-side framer rejects
    // them too.
    let header = b"Content-Length: 5\r\n\
                   Content-Length: 5\r\n\
                   \r\n";
    let body = b"hello";
    let mut bytes = Vec::with_capacity(header.len() + body.len());
    bytes.extend_from_slice(header);
    bytes.extend_from_slice(body);
    let mut reader = BufReader::new(&bytes[..]);
    let err = read_frame(&mut reader)
        .await
        .expect_err("read_frame should reject duplicate Content-Length");
    assert_eq!(err.kind(), ErrorKind::InvalidData);
    let msg = format!("{err}");
    assert!(
        msg.contains("duplicate") || msg.contains("Content-Length"),
        "error message should reference duplicate Content-Length, got: {msg}"
    );
}

#[tokio::test]
async fn read_rejects_over_cap_header_line() {
    // A 2 KiB header line is well over the 1 KiB cap; without it an unterminated line could exhaust
    // memory.
    let big_header_name = "X-Junk: ";
    let padding_len = 2 * 1024 - big_header_name.len();
    let padding: String = "A".repeat(padding_len);
    let mut bytes: Vec<u8> = Vec::new();
    bytes.extend_from_slice(big_header_name.as_bytes());
    bytes.extend_from_slice(padding.as_bytes());
    bytes.extend_from_slice(b"\r\n");
    bytes.extend_from_slice(b"Content-Length: 5\r\n\r\n");
    bytes.extend_from_slice(b"hello");

    let mut reader = BufReader::new(&bytes[..]);
    let err = read_frame(&mut reader)
        .await
        .expect_err("read_frame should reject over-cap header line");
    assert_eq!(err.kind(), ErrorKind::InvalidData);
}

// `CleanEof` (the daemon closed stdin between frames: exit 0) must stay distinct from
// `Err(UnexpectedEof)` (a truncated frame: exit non-zero, trips the crash budget). These tests pin
// each case.

#[tokio::test]
async fn read_frame_returns_clean_eof_at_frame_boundary() {
    // No byte was consumed for the next frame, so this is the graceful-shutdown signal.
    let bytes: Vec<u8> = Vec::new();
    let mut reader = BufReader::new(&bytes[..]);
    let outcome = read_frame(&mut reader)
        .await
        .expect("empty reader at frame boundary must NOT be an error");
    match outcome {
        FrameReadOutcome::CleanEof => {}
        FrameReadOutcome::Frame(body) => {
            panic!("expected CleanEof at empty boundary, got Frame({body:?})")
        }
    }
}

#[tokio::test]
async fn read_frame_returns_clean_eof_after_complete_frame() {
    // A complete frame, then `CleanEof` once the reader is drained.
    let mut buf: Vec<u8> = Vec::new();
    write_frame(&mut buf, b"hello").await.expect("write_frame");

    let mut reader = BufReader::new(&buf[..]);
    let first = read_frame(&mut reader).await.expect("first frame");
    match first {
        FrameReadOutcome::Frame(body) => assert_eq!(body, b"hello"),
        FrameReadOutcome::CleanEof => {
            panic!("expected Frame on first call, got CleanEof")
        }
    }
    let second = read_frame(&mut reader)
        .await
        .expect("second read at frame boundary must NOT be an error");
    match second {
        FrameReadOutcome::CleanEof => {}
        FrameReadOutcome::Frame(body) => {
            panic!("expected CleanEof after complete frame, got Frame({body:?})")
        }
    }
}

#[tokio::test]
async fn read_frame_returns_err_on_mid_header_truncation() {
    // A header line was consumed but the stream closes before the empty CRLF: mid-header
    // truncation, not a clean close.
    let bytes = b"Content-Length: 5\r\n".to_vec();
    let mut reader = BufReader::new(&bytes[..]);
    let err = read_frame(&mut reader)
        .await
        .expect_err("mid-header truncation must surface as Err, NOT CleanEof");
    assert_eq!(err.kind(), ErrorKind::UnexpectedEof);
    let msg = format!("{err}");
    assert!(
        msg.contains("mid-header-block"),
        "error message should identify mid-header truncation, got: {msg}"
    );
}

#[tokio::test]
async fn read_frame_returns_err_on_mid_body_truncation() {
    // The header advertises 10 bytes and only 5 arrive, so `read_exact` reports `UnexpectedEof`.
    // The message must also carry the declared length, which the bare std message lacks.
    let mut bytes = b"Content-Length: 10\r\n\r\n".to_vec();
    bytes.extend_from_slice(b"short");
    let mut reader = BufReader::new(&bytes[..]);
    let err = read_frame(&mut reader)
        .await
        .expect_err("mid-body truncation must surface as Err, NOT CleanEof");
    assert_eq!(err.kind(), ErrorKind::UnexpectedEof);
    let msg = format!("{err}");
    assert!(
        msg.contains("mid-body"),
        "error message should identify mid-body truncation, got: {msg}"
    );
    assert!(
        msg.contains("10"),
        "error message should include the declared body length (10), got: {msg}"
    );
}

#[tokio::test]
async fn read_frame_returns_err_on_partial_header_line_then_close() {
    // Partial bytes with no CRLF, then close. The stream is no longer at a frame boundary, so this
    // must not be `CleanEof`.
    let bytes = b"Content-Le".to_vec();
    let mut reader = BufReader::new(&bytes[..]);
    let err = read_frame(&mut reader)
        .await
        .expect_err("partial-header-line-then-close must NOT be CleanEof");
    // The CRLF check fires first; what matters is that the result is not `CleanEof`.
    assert!(
        err.kind() == ErrorKind::InvalidData || err.kind() == ErrorKind::UnexpectedEof,
        "partial-header-line-then-close must surface as InvalidData or UnexpectedEof, got {:?}: {err}",
        err.kind(),
    );
}
