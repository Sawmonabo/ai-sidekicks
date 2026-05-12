//! Round-trip tests for the Content-Length framing layer.
//!
//! Plan-024 Phase 1 / T-024-1-2 — verifies ADR-009 §Decision (LSP-style
//! Content-Length framing parity). Exercises header parsing edges, the
//! 8 MiB cap (F-024-1-06), and byte-identical write/read round-trip.

use std::io::ErrorKind;

use sidecar_rust_pty::framing::{read_frame, write_frame, FrameReadOutcome, MAX_FRAME_BODY_BYTES};
use tokio::io::BufReader;

/// Helper: unwrap [`FrameReadOutcome::Frame`] or panic. Tests that want
/// to inspect a `CleanEof` outcome should match on the variant directly
/// rather than going through this helper.
fn expect_frame(outcome: FrameReadOutcome) -> Vec<u8> {
    match outcome {
        FrameReadOutcome::Frame(body) => body,
        FrameReadOutcome::CleanEof => {
            panic!("expected FrameReadOutcome::Frame, got CleanEof")
        }
    }
}

/// Helper: write `body` via `write_frame` into a Vec, then read it back
/// via `read_frame`. Returns the recovered body.
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
    // Content-Length framing must survive newlines and CRLF sequences
    // inside the payload — that's the whole reason ADR-009 picked it over
    // newline-delimited JSON (Option E rejected for this exact failure mode).
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
    // Exactly MAX_FRAME_BODY_BYTES is acceptable — the cap is inclusive.
    let body = vec![0xABu8; MAX_FRAME_BODY_BYTES];
    let recovered = round_trip(&body).await;
    assert_eq!(recovered.len(), body.len());
    assert_eq!(recovered, body);
}

#[tokio::test]
async fn round_trip_near_cap_7_mib() {
    // 7 MiB, near but under the cap, with a non-trivial pattern.
    let size = 7 * 1024 * 1024;
    let body: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
    let recovered = round_trip(&body).await;
    assert_eq!(recovered.len(), body.len());
    assert_eq!(recovered, body);
}

#[tokio::test]
async fn write_rejects_over_cap_body() {
    // Write side enforces the cap symmetrically with the read side.
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
    // Hand-craft a header advertising MAX_FRAME_BODY_BYTES + 1; the reader
    // MUST reject before allocating that buffer or reading any body bytes.
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
    // Empty header block with no Content-Length is malformed.
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
    // LSP/ADR-009 require CRLF. Bare LF must be rejected, otherwise the
    // framer would silently accept non-conformant peers.
    let bytes = b"Content-Length: 5\n\nhello".to_vec();
    let mut reader = BufReader::new(&bytes[..]);
    let err = read_frame(&mut reader)
        .await
        .expect_err("read_frame should reject LF-only line terminators");
    assert_eq!(err.kind(), ErrorKind::InvalidData);
}

#[tokio::test]
async fn read_accepts_case_insensitive_content_length() {
    // LSP allows case variation on header names.
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
    // Content-Type (and any other auxiliary headers) must be tolerated on
    // read so a peer that advertises them does not get dropped.
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
    // Stream closes after a Content-Length line but before the empty CRLF
    // that terminates the header block.
    let bytes = b"Content-Length: 5\r\n".to_vec();
    let mut reader = BufReader::new(&bytes[..]);
    let err = read_frame(&mut reader)
        .await
        .expect_err("read_frame should reject EOF inside header block");
    assert_eq!(err.kind(), ErrorKind::UnexpectedEof);
}

#[tokio::test]
async fn read_rejects_eof_mid_body() {
    // Header advertises 10 bytes; only 3 are supplied. read_exact must
    // surface the truncation rather than returning a short body.
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
    // The dispatcher will read multiple frames from the same stream; verify
    // the reader leaves the buffer positioned correctly after each frame.
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
    // Two Content-Length headers is the request-smuggling shape. The TS
    // sibling framer (packages/runtime-daemon/src/ipc/local-ipc-gateway.ts)
    // rejects this at the boundary; the Rust framer must match.
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
    // Feed a 2 KiB header line (well over the 1 KiB MAX_HEADER_LINE_BYTES
    // cap). A malicious child could otherwise OOM the sidecar by streaming
    // an unterminated `Content-Type: AAAAA…` for gigabytes.
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

// --------------------------------------------------------------------------
// `FrameReadOutcome::CleanEof` vs `Err(UnexpectedEof)` taxonomy.
//
// The dispatcher distinguishes "daemon closed stdin between frames"
// (graceful shutdown — exit 0) from "stream truncated mid-frame"
// (transport corruption — exit non-zero, trip crash budget). These
// tests pin the boundary case-by-case so a regression that re-conflates
// them surfaces immediately. See `framing::FrameReadOutcome` rustdoc
// and `main.rs::run_dispatcher`'s error-handling philosophy block.
// --------------------------------------------------------------------------

#[tokio::test]
async fn read_frame_returns_clean_eof_at_frame_boundary() {
    // No bytes available at all — the stream closes before ANY header
    // bytes are consumed for the next frame. This is the graceful-
    // shutdown signal: the daemon closed stdin between frames.
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
    // First call returns a complete frame; second call (with the
    // reader fully drained) returns CleanEof. This is the canonical
    // shape of "daemon sent one frame, then closed cleanly."
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
    // Stream supplies a Content-Length header line (n > 0 → boundary
    // flipped to false) but closes before the empty CRLF terminator.
    // This is the post-flip mid-header truncation path — distinct
    // from the boundary-EOF clean-shutdown shape.
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
    // Header advertises 10 bytes; only 5 are supplied. read_exact
    // surfaces the truncation as UnexpectedEof. Distinct from the
    // CleanEof case because we have already started consuming bytes
    // for this frame.
    //
    // Additionally pin the diagnostic shape: the `read_exact` error is
    // wrapped with declared-length context so an operator triaging a
    // framing fault from sidecar stderr sees `mid-body (declared N
    // bytes)` parity with the mid-header arm's `mid-header-block`
    // message. Without the wrap, std would surface the bare "failed
    // to fill whole buffer" message — actionable kind, opaque text.
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
    // Stream supplies partial bytes (no CRLF terminator on the line)
    // and closes. The first `read_line` returns the partial line
    // (n > 0 → boundary flipped to false), then the CRLF check fires
    // and rejects with InvalidData. Importantly, this is NOT
    // misclassified as CleanEof — the n > 0 path took us off the
    // boundary even though the stream then ended on the next read.
    let bytes = b"Content-Le".to_vec();
    let mut reader = BufReader::new(&bytes[..]);
    let err = read_frame(&mut reader)
        .await
        .expect_err("partial-header-line-then-close must NOT be CleanEof");
    // The CRLF check fires before the boundary-EOF arm — InvalidData
    // is the load-bearing assertion (we MUST NOT return CleanEof for
    // this shape; the specific error kind is secondary).
    assert!(
        err.kind() == ErrorKind::InvalidData || err.kind() == ErrorKind::UnexpectedEof,
        "partial-header-line-then-close must surface as InvalidData or UnexpectedEof, got {:?}: {err}",
        err.kind(),
    );
}
