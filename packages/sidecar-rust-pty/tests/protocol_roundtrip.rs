//! JSON round-trip tests for the daemon ↔ sidecar wire protocol.
//!
//! Every variant of [`Envelope`] is exercised: serialize to JSON,
//! deserialize back, `assert_eq!`. Additional tests verify the load-
//! bearing wire properties:
//!
//! - `DataFrame.bytes` and `WriteRequest.bytes` ride the wire as
//!   base64 strings (per F-024-1-01).
//! - The `kind` discriminant is on-wire at the top level of every
//!   envelope object (per F-024-1-02).
//! - Unknown `kind` values fail deserialization (otherwise the
//!   dispatcher would silently drop messages it cannot route).
//!
//! Plan-024 Phase 1 / T-024-1-3.

use serde_json::{json, Value};
use sidecar_rust_pty::protocol::{
    DataFrame, DataStream, Envelope, ExitCodeNotification, KillRequest, KillResponse, PingRequest,
    PingResponse, PtySignal, ResizeRequest, ResizeResponse, SpawnRequest, SpawnResponse,
    WriteRequest, WriteResponse,
};

/// Helper: serialize via `serde_json`, deserialize back, assert equality.
fn round_trip(envelope: &Envelope) -> Envelope {
    let json = serde_json::to_string(envelope).expect("serialize must succeed");
    serde_json::from_str(&json).expect("deserialize must succeed")
}

// ---------------------------------------------------------------------------
// One round-trip test per variant.
// ---------------------------------------------------------------------------

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

/// Pins UTF-8 round-trip across every String field on SpawnRequest:
/// `command` (BMP only — process spawn surfaces typically restrict to
/// filesystem-encoded names), `args` (BMP + emoji / astral plane),
/// `env` keys and values (locale-bearing values like LANG), and `cwd`
/// (non-ASCII paths from localized HOME directories). Prevents a silent
/// regression if the framing or JSON layer ever swaps codecs.
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
    });
    assert_eq!(round_trip(&envelope), envelope);
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
    });
    assert_eq!(round_trip(&envelope), envelope);
}

#[test]
fn round_trip_kill_request_each_signal() {
    // Cover every signal so the rename = "SIG..." mapping is exercised on
    // every variant — a regression here would silently route the wrong
    // signal to the child process.
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
    });
    assert_eq!(round_trip(&envelope), envelope);
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
    // POSIX signal-terminated child: signal_code is Some, exit_code is
    // platform-conventional (often 128 + signal number).
    let envelope = Envelope::ExitCodeNotification(ExitCodeNotification {
        session_id: "s-1".to_string(),
        exit_code: 130,
        signal_code: Some(2),
    });
    assert_eq!(round_trip(&envelope), envelope);
}

/// Pins the on-wire shape of `signal_code: None`: it MUST serialize as a
/// JSON `null`, not as an absent key. The TS mirror declares the field
/// as `signal_code: number | null` (NOT `signal_code?: number`); a
/// future `#[serde(skip_serializing_if = "Option::is_none")]` attribute
/// would round-trip cleanly in Rust (Option deserializes both `null` and
/// absent to None) yet silently break the TS consumer's narrowing — the
/// field would become `undefined` on the wire, which the declared type
/// cannot represent. Hold the line at the serializer.
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
    // And the key must actually be present on the object (asserting
    // `is_null()` alone wouldn't distinguish absent from null).
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

// ---------------------------------------------------------------------------
// Base64 wire-shape verification (F-024-1-01).
// ---------------------------------------------------------------------------

/// On-wire `bytes` MUST be a base64 string, not a JSON array of numbers.
/// A regression here would double encoding cost AND break the TS mirror
/// (whose `bytes: string` type cannot accept an array).
#[test]
fn data_frame_bytes_round_trips_as_base64_string() {
    let original = DataFrame {
        session_id: "s-1".to_string(),
        stream: DataStream::Stdout,
        seq: 1,
        // [0, 1, 255] → base64 standard alphabet → "AAH/".
        bytes: vec![0u8, 1, 255],
    };
    let envelope = Envelope::DataFrame(original.clone());
    let json: Value = serde_json::to_value(&envelope).expect("serialize to value");

    // Confirm the on-wire shape: bytes is a string, equal to the base64
    // encoding of [0, 1, 255].
    assert_eq!(
        json["bytes"],
        Value::String("AAH/".to_string()),
        "DataFrame.bytes must serialize as a base64 string (got {})",
        json["bytes"]
    );

    // And the round-trip recovers the original byte sequence.
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
    // Empty payload is a legitimate shape (e.g., a stream-flush signal);
    // it MUST NOT panic, and the on-wire base64 must be the empty string.
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

// ---------------------------------------------------------------------------
// `kind` discriminant on-wire (F-024-1-02).
// ---------------------------------------------------------------------------

/// The dispatcher MUST be able to route by `kind` without a full
/// deserialize of the variant payload. Confirm the discriminant is on
/// the top-level JSON object.
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
    // Verifies that a TS-side producer (which builds the JSON by hand
    // from the `pty-host-protocol.ts` mirror) can construct a payload
    // that the Rust dispatcher accepts. This is the on-wire contract:
    // top-level `kind` + payload fields at the same depth.
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
    // The TS mirror declares `DataFrame.bytes: string` (base64); a
    // producer building the JSON by hand MUST be able to pass a base64
    // string at the `bytes` slot and have the sidecar decode it.
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
    // Symmetric to `hand_rolled_data_frame_...`: WriteRequest.bytes is
    // the OTHER base64-carrying field, and a TS-side producer building
    // stdin payloads by hand is the realistic daemon-layer code path.
    // Pins the on-wire field names (`kind`, `session_id`, `bytes`) and
    // the base64 decode for the WriteRequest variant.
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

// ---------------------------------------------------------------------------
// Negative cases — unknown / malformed `kind`.
// ---------------------------------------------------------------------------

#[test]
fn unknown_kind_fails_to_deserialize() {
    // The dispatcher MUST NOT silently route an unknown message — a
    // peer that sends `kind: "frobnicate"` is either a version mismatch
    // or a hostile sender. Either way, the parse must reject.
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
    // Without the discriminant, the dispatcher cannot route. Reject at
    // the parse boundary rather than guessing.
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
    // PtySignal accepts only the four POSIX names; an unknown signal
    // string at this layer is a contract violation.
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
