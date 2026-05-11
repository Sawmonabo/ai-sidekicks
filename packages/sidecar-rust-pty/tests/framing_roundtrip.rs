//! Round-trip tests for the Content-Length framing layer.
//!
//! Plan-024 Phase 1 / T-024-1-2 — verifies ADR-009 §Decision (LSP-style
//! Content-Length framing parity). Exercises header parsing edges, the
//! 8 MiB cap (F-024-1-06), and byte-identical write/read round-trip.

use std::io::ErrorKind;

use sidecar_rust_pty::framing::{read_frame, write_frame, MAX_FRAME_BODY_BYTES};
use tokio::io::BufReader;

/// Helper: write `body` via `write_frame` into a Vec, then read it back
/// via `read_frame`. Returns the recovered body.
async fn round_trip(body: &[u8]) -> Vec<u8> {
    let mut buf: Vec<u8> = Vec::new();
    write_frame(&mut buf, body)
        .await
        .expect("write_frame should succeed");

    let mut reader = BufReader::new(&buf[..]);
    read_frame(&mut reader)
        .await
        .expect("read_frame should succeed")
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
    let recovered = read_frame(&mut reader)
        .await
        .expect("lowercase header should be accepted");
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
    let recovered = read_frame(&mut reader)
        .await
        .expect("auxiliary headers should be ignored, not rejected");
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
    let got_a = read_frame(&mut reader).await.expect("read A");
    let got_b = read_frame(&mut reader).await.expect("read B");
    assert_eq!(got_a, body_a);
    assert_eq!(got_b, body_b);
}
