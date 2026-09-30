//! JSON round-trip tests for the daemon-to-sidecar wire protocol.
//!
//! Every [`Envelope`] variant is serialized and deserialized back. Further tests pin wire
//! properties: `bytes` fields travel as base64 strings, `kind` is a top-level key on every
//! envelope, and an unknown `kind` fails to deserialize so the dispatcher never silently drops a
//! message it cannot route.

use serde_json::{json, Value};
use sidecar_rust_pty::protocol::{
    DataFrame, DataStream, Envelope, ExitCodeNotification, KillRequest, KillResponse, PingRequest,
    PingResponse, PtySignal, ResizeRequest, ResizeResponse, SpawnRequest, SpawnResponse,
    WriteRequest, WriteResponse,
};

/// Serializes to JSON and deserializes back.
fn round_trip(envelope: &Envelope) -> Envelope {
    let json = serde_json::to_string(envelope).expect("serialize must succeed");
    serde_json::from_str(&json).expect("deserialize must succeed")
}

// One round-trip test per variant.

#[test]
fn round_trip_spawn_request() {
    let envelope = Envelope::SpawnRequest(SpawnRequest {
        command: "bash".to_string(),
        args: vec!["-c".to_string(), "echo hello".to_string()],
        env: vec![
            ("PATH".to_string(), "/usr/bin:/bin".to_string()),
            ("HOME".to_string(), "/home/u".to_string()),
        ],
        cwd: "/tmp".to_string(),
        rows: 24,
        cols: 80,
    });
    assert_eq!(round_trip(&envelope), envelope);
}

/// UTF-8 must round-trip in every `SpawnRequest` string field (BMP and astral characters), so
/// swapping the JSON or framing codec breaks a test.
#[test]
fn round_trip_spawn_request_non_ascii_utf8() {
    let envelope = Envelope::SpawnRequest(SpawnRequest {
        command: "echo".to_string(),
        args: vec!["こんにちは".to_string(), "🦀".to_string()],
        env: vec![
            ("LANG".to_string(), "ja_JP.UTF-8".to_string()),
            ("USER".to_string(), "たろう".to_string()),
        ],
        cwd: "/home/たろう/projects".to_string(),
        rows: 24,
        cols: 80,
    });
    assert_eq!(round_trip(&envelope), envelope);
}

#[test]
fn round_trip_spawn_response() {
    let envelope = Envelope::SpawnResponse(SpawnResponse {
        session_id: "01900000-0000-7000-8000-000000000001".to_string(),
        error: None,
    });
    assert_eq!(round_trip(&envelope), envelope);
}

/// A failed spawn: an empty `session_id` (no session was created) and an `error` message.
#[test]
fn round_trip_spawn_response_with_error() {
    let envelope = Envelope::SpawnResponse(SpawnResponse {
        session_id: String::new(),
        error: Some("portable-pty error: No such file or directory (os error 2)".to_string()),
    });
    assert_eq!(round_trip(&envelope), envelope);
}

/// `SpawnResponse.error: None` is absent on the wire, which the TS mirror's `error?: string` relies
/// on.
#[test]
fn spawn_response_error_none_is_absent_on_wire() {
    let envelope = Envelope::SpawnResponse(SpawnResponse {
        session_id: "s-1".to_string(),
        error: None,
    });
    let json: Value = serde_json::to_value(&envelope).expect("serialize to value");
    assert!(
        !json
            .as_object()
            .expect("envelope must serialize as JSON object")
            .contains_key("error"),
        "error key MUST be absent on the wire when None (got {json})"
    );
}

/// A `SpawnResponse` without an `error` field must deserialize to `error: None`; this guards
/// `#[serde(default)]`.
#[test]
fn spawn_response_without_error_field_deserializes_to_none() {
    let raw = json!({
        "kind": "spawn_response",
        "session_id": "s-1",
    });
    let envelope: Envelope = serde_json::from_value(raw).expect("deserialize must succeed");
    match envelope {
        Envelope::SpawnResponse(resp) => {
            assert_eq!(resp.session_id, "s-1");
            assert_eq!(resp.error, None);
        }
        other => panic!("expected SpawnResponse, got: {other:?}"),
    }
}

#[test]
fn round_trip_resize_request() {
    let envelope = Envelope::ResizeRequest(ResizeRequest {
        session_id: "s-1".to_string(),
        rows: 40,
        cols: 132,
    });
    assert_eq!(round_trip(&envelope), envelope);
}

#[test]
fn round_trip_resize_response() {
    let envelope = Envelope::ResizeResponse(ResizeResponse {
        session_id: "s-1".to_string(),
        error: None,
    });
    assert_eq!(round_trip(&envelope), envelope);
}

/// `error: Some(msg)` must serialize as a JSON string and round-trip to the same `Some(msg)`.
#[test]
fn round_trip_resize_response_with_error() {
    let envelope = Envelope::ResizeResponse(ResizeResponse {
        session_id: "s-1".to_string(),
        error: Some("session_id \"s-1\" is not active".to_string()),
    });
    assert_eq!(round_trip(&envelope), envelope);
}

#[test]
fn round_trip_write_request() {
    let envelope = Envelope::WriteRequest(WriteRequest {
        session_id: "s-1".to_string(),
        bytes: b"hello\n".to_vec(),
    });
    assert_eq!(round_trip(&envelope), envelope);
}

#[test]
fn round_trip_write_response() {
    let envelope = Envelope::WriteResponse(WriteResponse {
        session_id: "s-1".to_string(),
        error: None,
    });
    assert_eq!(round_trip(&envelope), envelope);
}

#[test]
fn round_trip_write_response_with_error() {
    let envelope = Envelope::WriteResponse(WriteResponse {
        session_id: "s-1".to_string(),
        error: Some("writer for session \"s-1\" has already been taken".to_string()),
    });
    assert_eq!(round_trip(&envelope), envelope);
}

#[test]
fn round_trip_kill_request_each_signal() {
    // Every signal, so the `SIG...` rename is exercised on each variant.
    for signal in [
        PtySignal::Sigint,
        PtySignal::Sigterm,
        PtySignal::Sigkill,
        PtySignal::Sighup,
    ] {
        let envelope = Envelope::KillRequest(KillRequest {
            session_id: "s-1".to_string(),
            signal,
        });
        assert_eq!(round_trip(&envelope), envelope);
    }
}

#[test]
fn round_trip_kill_response() {
    let envelope = Envelope::KillResponse(KillResponse {
        session_id: "s-1".to_string(),
        error: None,
    });
    assert_eq!(round_trip(&envelope), envelope);
}

#[test]
fn round_trip_kill_response_with_error() {
    let envelope = Envelope::KillResponse(KillResponse {
        session_id: "s-1".to_string(),
        error: Some("session_id \"s-1\" is not active".to_string()),
    });
    assert_eq!(round_trip(&envelope), envelope);
}

/// `error: None` is absent on the wire. The TS mirror declares `error?: string`, and emitting
/// `"error": null` would break its narrowing; `skip_serializing_if` is what this pins.
#[test]
fn kill_response_error_none_is_absent_on_wire() {
    let envelope = Envelope::KillResponse(KillResponse {
        session_id: "s-1".to_string(),
        error: None,
    });
    let json: Value = serde_json::to_value(&envelope).expect("serialize to value");
    assert!(
        !json
            .as_object()
            .expect("envelope must serialize as JSON object")
            .contains_key("error"),
        "error key MUST be absent on the wire when None (got {json})"
    );
}

/// The same absent-on-wire check for `WriteResponse`.
#[test]
fn write_response_error_none_is_absent_on_wire() {
    let envelope = Envelope::WriteResponse(WriteResponse {
        session_id: "s-1".to_string(),
        error: None,
    });
    let json: Value = serde_json::to_value(&envelope).expect("serialize to value");
    assert!(
        !json
            .as_object()
            .expect("envelope must serialize as JSON object")
            .contains_key("error"),
        "error key MUST be absent on the wire when None (got {json})"
    );
}

/// The same absent-on-wire check for `ResizeResponse`.
#[test]
fn resize_response_error_none_is_absent_on_wire() {
    let envelope = Envelope::ResizeResponse(ResizeResponse {
        session_id: "s-1".to_string(),
        error: None,
    });
    let json: Value = serde_json::to_value(&envelope).expect("serialize to value");
    assert!(
        !json
            .as_object()
            .expect("envelope must serialize as JSON object")
            .contains_key("error"),
        "error key MUST be absent on the wire when None (got {json})"
    );
}

/// `error: Some(msg)` must serialize as a plain JSON string.
#[test]
fn kill_response_error_some_serializes_as_string() {
    let envelope = Envelope::KillResponse(KillResponse {
        session_id: "s-1".to_string(),
        error: Some("session_id \"s-1\" is not active".to_string()),
    });
    let json: Value = serde_json::to_value(&envelope).expect("serialize to value");
    assert_eq!(
        json["error"],
        Value::String("session_id \"s-1\" is not active".to_string()),
        "error Some(msg) must serialize as a JSON string (got {})",
        json["error"]
    );
}

/// A payload without `error` must deserialize to `error: None`; this guards `#[serde(default)]`.
#[test]
fn kill_response_without_error_field_deserializes_to_none() {
    let raw = json!({
        "kind": "kill_response",
        "session_id": "s-1",
    });
    let envelope: Envelope = serde_json::from_value(raw).expect("deserialize must succeed");
    match envelope {
        Envelope::KillResponse(resp) => {
            assert_eq!(resp.session_id, "s-1");
            assert_eq!(resp.error, None);
        }
        other => panic!("expected KillResponse, got: {other:?}"),
    }
}

#[test]
fn round_trip_exit_code_notification_normal_exit() {
    let envelope = Envelope::ExitCodeNotification(ExitCodeNotification {
        session_id: "s-1".to_string(),
        exit_code: 0,
        signal_code: None,
    });
    assert_eq!(round_trip(&envelope), envelope);
}

#[test]
fn round_trip_exit_code_notification_signal_terminated() {
    // A signal-terminated child: `signal_code` is `Some` and `exit_code` is typically 128 plus the
    // signal number.
    let envelope = Envelope::ExitCodeNotification(ExitCodeNotification {
        session_id: "s-1".to_string(),
        exit_code: 130,
        signal_code: Some(2),
    });
    assert_eq!(round_trip(&envelope), envelope);
}

/// `signal_code: None` must serialize as JSON `null`, not an absent key: the TS mirror declares
/// `signal_code: number | null`, and `skip_serializing_if` would round-trip in Rust yet break that
/// type.
#[test]
fn exit_code_notification_signal_code_none_serializes_as_json_null() {
    let envelope = Envelope::ExitCodeNotification(ExitCodeNotification {
        session_id: "s-1".to_string(),
        exit_code: 0,
        signal_code: None,
    });
    let json: Value = serde_json::to_value(&envelope).expect("serialize to value");
    assert_eq!(
        json["signal_code"],
        Value::Null,
        "signal_code None must serialize as JSON null, not absent (got {})",
        json
    );
    // `null` alone would not distinguish an absent key, so check the key is present.
    assert!(
        json.as_object()
            .expect("envelope must serialize as JSON object")
            .contains_key("signal_code"),
        "signal_code key must be present on the wire (got {json})"
    );
}

#[test]
fn round_trip_ping_request() {
    let envelope = Envelope::PingRequest(PingRequest {});
    assert_eq!(round_trip(&envelope), envelope);
}

#[test]
fn round_trip_ping_response() {
    let envelope = Envelope::PingResponse(PingResponse {});
    assert_eq!(round_trip(&envelope), envelope);
}

#[test]
fn round_trip_data_frame_stdout() {
    let envelope = Envelope::DataFrame(DataFrame {
        session_id: "s-1".to_string(),
        stream: DataStream::Stdout,
        seq: 0,
        bytes: b"first chunk".to_vec(),
    });
    assert_eq!(round_trip(&envelope), envelope);
}

#[test]
fn round_trip_data_frame_stderr() {
    let envelope = Envelope::DataFrame(DataFrame {
        session_id: "s-1".to_string(),
        stream: DataStream::Stderr,
        seq: u64::MAX,
        bytes: b"error chunk".to_vec(),
    });
    assert_eq!(round_trip(&envelope), envelope);
}

/// `bytes` must be a base64 string, not a JSON array of numbers, which the TS mirror's
/// `bytes: string` cannot accept.
#[test]
fn data_frame_bytes_round_trips_as_base64_string() {
    let original = DataFrame {
        session_id: "s-1".to_string(),
        stream: DataStream::Stdout,
        seq: 1,
        // [0, 1, 255] encodes to "AAH/" in standard base64.
        bytes: vec![0u8, 1, 255],
    };
    let envelope = Envelope::DataFrame(original.clone());
    let json: Value = serde_json::to_value(&envelope).expect("serialize to value");

    // The wire value is the base64 encoding.
    assert_eq!(
        json["bytes"],
        Value::String("AAH/".to_string()),
        "DataFrame.bytes must serialize as a base64 string (got {})",
        json["bytes"]
    );

    let recovered: Envelope = serde_json::from_value(json).expect("deserialize from value");
    match recovered {
        Envelope::DataFrame(df) => assert_eq!(df.bytes, original.bytes),
        other => panic!("expected DataFrame variant, got: {other:?}"),
    }
}

#[test]
fn write_request_bytes_round_trips_as_base64_string() {
    let original = WriteRequest {
        session_id: "s-1".to_string(),
        bytes: vec![0u8, 1, 255],
    };
    let envelope = Envelope::WriteRequest(original.clone());
    let json: Value = serde_json::to_value(&envelope).expect("serialize to value");

    assert_eq!(
        json["bytes"],
        Value::String("AAH/".to_string()),
        "WriteRequest.bytes must serialize as a base64 string (got {})",
        json["bytes"]
    );

    let recovered: Envelope = serde_json::from_value(json).expect("deserialize from value");
    match recovered {
        Envelope::WriteRequest(wr) => assert_eq!(wr.bytes, original.bytes),
        other => panic!("expected WriteRequest variant, got: {other:?}"),
    }
}

#[test]
fn data_frame_empty_bytes_round_trips() {
    // An empty payload is legitimate; it must not panic and encodes as the empty string.
    let envelope = Envelope::DataFrame(DataFrame {
        session_id: "s-1".to_string(),
        stream: DataStream::Stdout,
        seq: 0,
        bytes: Vec::new(),
    });
    let json: Value = serde_json::to_value(&envelope).expect("serialize to value");
    assert_eq!(json["bytes"], Value::String(String::new()));
    assert_eq!(round_trip(&envelope), envelope);
}

/// The discriminant must sit on the top-level JSON object so the dispatcher can route by `kind`.
#[test]
fn envelope_kind_is_top_level_snake_case() {
    let cases: &[(Envelope, &str)] = &[
        (
            Envelope::SpawnRequest(SpawnRequest {
                command: "ls".to_string(),
                args: Vec::new(),
                env: Vec::new(),
                cwd: "/tmp".to_string(),
                rows: 24,
                cols: 80,
            }),
            "spawn_request",
        ),
        (
            Envelope::SpawnResponse(SpawnResponse {
                session_id: "s-1".to_string(),
                error: None,
            }),
            "spawn_response",
        ),
        (
            Envelope::ResizeRequest(ResizeRequest {
                session_id: "s-1".to_string(),
                rows: 24,
                cols: 80,
            }),
            "resize_request",
        ),
        (
            Envelope::ResizeResponse(ResizeResponse {
                session_id: "s-1".to_string(),
                error: None,
            }),
            "resize_response",
        ),
        (
            Envelope::WriteRequest(WriteRequest {
                session_id: "s-1".to_string(),
                bytes: vec![1, 2, 3],
            }),
            "write_request",
        ),
        (
            Envelope::WriteResponse(WriteResponse {
                session_id: "s-1".to_string(),
                error: None,
            }),
            "write_response",
        ),
        (
            Envelope::KillRequest(KillRequest {
                session_id: "s-1".to_string(),
                signal: PtySignal::Sigint,
            }),
            "kill_request",
        ),
        (
            Envelope::KillResponse(KillResponse {
                session_id: "s-1".to_string(),
                error: None,
            }),
            "kill_response",
        ),
        (
            Envelope::ExitCodeNotification(ExitCodeNotification {
                session_id: "s-1".to_string(),
                exit_code: 0,
                signal_code: None,
            }),
            "exit_code_notification",
        ),
        (Envelope::PingRequest(PingRequest {}), "ping_request"),
        (Envelope::PingResponse(PingResponse {}), "ping_response"),
        (
            Envelope::DataFrame(DataFrame {
                session_id: "s-1".to_string(),
                stream: DataStream::Stdout,
                seq: 0,
                bytes: Vec::new(),
            }),
            "data_frame",
        ),
    ];

    for (envelope, expected_kind) in cases {
        let json: Value = serde_json::to_value(envelope).expect("serialize to value");
        let kind = json
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("envelope must carry top-level 'kind' string: {json}"));
        assert_eq!(
            kind, *expected_kind,
            "wrong discriminant for {envelope:?}: expected {expected_kind}, got {kind}"
        );
    }
}

#[test]
fn hand_rolled_spawn_request_json_deserializes_to_envelope() {
    // A hand-built payload as the TS producer writes it (mirroring `pty-host-protocol.ts` in
    // `packages/contracts`): top-level `kind` and payload fields at the same depth.
    let raw = json!({
        "kind": "spawn_request",
        "command": "ls",
        "args": ["-la"],
        "env": [["PATH", "/usr/bin"]],
        "cwd": "/tmp",
        "rows": 24,
        "cols": 80,
    });
    let envelope: Envelope = serde_json::from_value(raw).expect("deserialize must succeed");
    match envelope {
        Envelope::SpawnRequest(req) => {
            assert_eq!(req.command, "ls");
            assert_eq!(req.args, vec!["-la".to_string()]);
            assert_eq!(req.env, vec![("PATH".to_string(), "/usr/bin".to_string())]);
            assert_eq!(req.cwd, "/tmp");
            assert_eq!(req.rows, 24);
            assert_eq!(req.cols, 80);
        }
        other => panic!("expected SpawnRequest, got: {other:?}"),
    }
}

#[test]
fn hand_rolled_data_frame_json_with_base64_bytes_deserializes() {
    // A hand-built `DataFrame` with a base64 `bytes` string must decode.
    let raw = json!({
        "kind": "data_frame",
        "session_id": "s-1",
        "stream": "stdout",
        "seq": 7,
        "bytes": "AAH/",
    });
    let envelope: Envelope = serde_json::from_value(raw).expect("deserialize must succeed");
    match envelope {
        Envelope::DataFrame(df) => {
            assert_eq!(df.session_id, "s-1");
            assert_eq!(df.stream, DataStream::Stdout);
            assert_eq!(df.seq, 7);
            assert_eq!(df.bytes, vec![0u8, 1, 255]);
        }
        other => panic!("expected DataFrame, got: {other:?}"),
    }
}

#[test]
fn hand_rolled_write_request_json_with_base64_bytes_deserializes() {
    // The other base64 field; pins the on-wire field names and the decode for `WriteRequest`.
    let raw = json!({
        "kind": "write_request",
        "session_id": "s-1",
        "bytes": "AAH/",
    });
    let envelope: Envelope = serde_json::from_value(raw).expect("deserialize must succeed");
    match envelope {
        Envelope::WriteRequest(wr) => {
            assert_eq!(wr.session_id, "s-1");
            assert_eq!(wr.bytes, vec![0u8, 1, 255]);
        }
        other => panic!("expected WriteRequest, got: {other:?}"),
    }
}

// Negative cases: unknown or malformed `kind`.

#[test]
fn unknown_kind_fails_to_deserialize() {
    // An unknown message must be rejected, not routed: the sender is a version mismatch or hostile.
    let raw = json!({
        "kind": "frobnicate",
        "session_id": "s-1",
    });
    let err = serde_json::from_value::<Envelope>(raw).expect_err("unknown kind must be rejected");
    let msg = err.to_string();
    assert!(
        msg.contains("frobnicate") || msg.contains("variant"),
        "error should mention the unknown variant or 'variant': {msg}"
    );
}

#[test]
fn missing_kind_fails_to_deserialize() {
    // Without a discriminant the message cannot be routed; reject it at parse time.
    let raw = json!({
        "session_id": "s-1",
    });
    let err = serde_json::from_value::<Envelope>(raw)
        .expect_err("missing kind discriminant must be rejected");
    let msg = err.to_string();
    assert!(
        msg.contains("kind") || msg.contains("tag") || msg.contains("variant"),
        "error should mention the missing tag: {msg}"
    );
}

#[test]
fn unknown_signal_fails_to_deserialize() {
    // `PtySignal` accepts only the four POSIX names.
    let raw = json!({
        "kind": "kill_request",
        "session_id": "s-1",
        "signal": "SIGUSR1",
    });
    let err = serde_json::from_value::<Envelope>(raw).expect_err("unknown signal must be rejected");
    let msg = err.to_string();
    assert!(
        msg.contains("SIGUSR1") || msg.contains("variant") || msg.contains("signal"),
        "error should mention the unknown signal: {msg}"
    );
}
