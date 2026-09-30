//! Wire-format tests for the daemon-to-sidecar protocol that the TS mirror in `packages/contracts`
//! depends on: `kind` is a top-level snake_case key on every envelope, `bytes` fields travel as
//! base64 strings, a `None` error is absent while a `None` signal code is `null`, and a payload
//! written the way the TS producer writes it deserializes.

use serde_json::{json, Value};
use sidecar_rust_pty::protocol::{
    DataFrame, DataStream, Envelope, ExitCodeNotification, KillRequest, KillResponse, PingRequest,
    PingResponse, PtySignal, ResizeRequest, ResizeResponse, SpawnRequest, SpawnResponse,
    WriteRequest, WriteResponse,
};

/// `error: None` is absent on the wire. The TS mirror declares `error?: string`, and emitting
/// `"error": null` would break its narrowing; `skip_serializing_if` is what this pins.
#[test]
fn response_error_none_is_absent_on_wire() {
    let envelopes = [
        Envelope::SpawnResponse(SpawnResponse {
            session_id: "s-1".to_string(),
            error: None,
        }),
        Envelope::KillResponse(KillResponse {
            session_id: "s-1".to_string(),
            error: None,
        }),
        Envelope::WriteResponse(WriteResponse {
            session_id: "s-1".to_string(),
            error: None,
        }),
        Envelope::ResizeResponse(ResizeResponse {
            session_id: "s-1".to_string(),
            error: None,
        }),
    ];
    for envelope in envelopes {
        let json: Value = serde_json::to_value(&envelope).expect("serialize to value");
        assert!(
            !json
                .as_object()
                .expect("envelope must serialize as JSON object")
                .contains_key("error"),
            "error key MUST be absent on the wire when None (got {json})"
        );
    }
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
