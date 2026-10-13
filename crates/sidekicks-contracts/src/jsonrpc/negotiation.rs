//! The `daemon.hello` handshake shared by the daemon and its clients. A protocol version is an
//! ISO 8601 `YYYY-MM-DD` date, so text order is chronological.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::jsonrpc::refusal::RefusalCode;
use crate::trust_statement::DeviceId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire;
use crate::wire::list::BoundedVec;
use crate::wire::text::{BoundedText, pattern_text};

ts_constants! {
    /// The JSON-RPC method name of the negotiation handshake.
    pub const DAEMON_HELLO_METHOD: &str = "daemon.hello";
    /// The longest a free-form negotiation string (`clientId`, a capability tag) may be.
    pub const NEGOTIATION_FIELD_MAX_LEN: usize = 256;
    /// The most entries any protocol-version or capability list in the handshake may carry.
    pub const SUPPORTED_PROTOCOLS_MAX_LEN: usize = 32;
    /// The protocol version this build speaks: the version a client offers in `daemon.hello`, and
    /// the newest one the daemon accepts.
    pub const CURRENT_PROTOCOL_VERSION: &str = "2026-05-01";
    /// The protocol versions this build speaks, newest last: its own, and the one before it once a
    /// release has shipped one. The daemon accepts exactly these, and a client offers exactly
    /// these in `daemon.hello`.
    pub const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &[CURRENT_PROTOCOL_VERSION];
    /// Ack reason: the client is too old for the daemon.
    NEGOTIATION_REASON_FLOOR_EXCEEDED = NegotiationIncompatibleReason::FloorExceeded;
    /// Ack reason: the client is too new for the daemon.
    NEGOTIATION_REASON_CEILING_EXCEEDED = NegotiationIncompatibleReason::CeilingExceeded;
    /// Ack reason: this connection already completed a handshake.
    NEGOTIATION_REASON_HANDSHAKE_ALREADY_COMPLETED =
        NegotiationIncompatibleReason::HandshakeAlreadyCompleted;
    /// The refusal of a mutating call on a connection whose handshake answered
    /// `compatible: false`.
    NEGOTIATION_VERSION_MISMATCH_CODE = RefusalCode::ProtocolVersionMismatch;
    /// The refusal of every call on a connection whose `daemon.hello` carried no session token or
    /// the wrong one, the hello included.
    NEGOTIATION_TOKEN_INVALID_CODE = RefusalCode::AuthTokenInvalid;
    /// The refusal of every call, whatever token it carried, on a connection opened by a process
    /// the daemon started outside the person's terminals, or one the system could not name or
    /// trace to its first process.
    NEGOTIATION_CALLER_REFUSED_CODE = RefusalCode::AuthCallerRefused;
}

pattern_text! {
    /// A protocol version: a `YYYY-MM-DD` date.
    pub struct ProtocolVersion("^[0-9]{4}-[0-9]{2}-[0-9]{2}$");
}

/// A non-empty free-form negotiation string.
pub type NegotiationText = BoundedText<1, NEGOTIATION_FIELD_MAX_LEN>;

/// The `daemon.hello` request, the first call on a connection: the client's preferred version,
/// its full supported set (by default `[protocolVersion]`), and the daemon's session token read
/// from its token file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DaemonHello {
    /// The client's preferred version.
    pub protocol_version: ProtocolVersion,
    /// Every version the client speaks.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "wire::present"
    )]
    #[schemars(with = "BoundedVec<ProtocolVersion, 1, SUPPORTED_PROTOCOLS_MAX_LEN>")]
    pub supported_protocols: Option<BoundedVec<ProtocolVersion, 1, SUPPORTED_PROTOCOLS_MAX_LEN>>,
    /// The client's name for itself.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "wire::present"
    )]
    #[schemars(with = "NegotiationText")]
    pub client_id: Option<NegotiationText>,
    /// The session token the daemon wrote to its token file at this start; its absence is
    /// answered as a wrong one, `auth.token_invalid`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "wire::present"
    )]
    #[schemars(with = "NegotiationText")]
    pub session_token: Option<NegotiationText>,
    /// The capability tags the client offers.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "wire::present"
    )]
    #[schemars(with = "BoundedVec<NegotiationText, 0, SUPPORTED_PROTOCOLS_MAX_LEN>")]
    pub capabilities: Option<BoundedVec<NegotiationText, 0, SUPPORTED_PROTOCOLS_MAX_LEN>>,
}

/// Why a handshake is incompatible. It rides in the ack, which is a successful response, not as a
/// JSON-RPC error.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub enum NegotiationIncompatibleReason {
    /// The client is too old.
    #[serde(rename = "version.floor_exceeded")]
    FloorExceeded,
    /// The client is too new.
    #[serde(rename = "version.ceiling_exceeded")]
    CeilingExceeded,
    /// A second handshake arrived on the connection.
    #[serde(rename = "protocol.handshake_already_completed")]
    HandshakeAlreadyCompleted,
}

/// The `daemon.hello` result. When `compatible` is false only read-only calls are allowed, and
/// `protocolVersion` is the daemon's newest; `reason` and `daemonSupportedProtocols` appear only
/// on an incompatible first handshake.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DaemonHelloAck {
    /// Whether the client and the daemon share a version.
    pub compatible: bool,
    /// The negotiated version, or the daemon's newest when incompatible.
    pub protocol_version: ProtocolVersion,
    /// The connecting device's own id; for a local connection, the service's own.
    pub device_id: DeviceId,
    /// Why the handshake is incompatible.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "wire::present"
    )]
    #[schemars(with = "NegotiationIncompatibleReason")]
    pub reason: Option<NegotiationIncompatibleReason>,
    /// The capability tags the daemon offers.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "wire::present"
    )]
    #[schemars(with = "BoundedVec<NegotiationText, 0, SUPPORTED_PROTOCOLS_MAX_LEN>")]
    pub server_capabilities: Option<BoundedVec<NegotiationText, 0, SUPPORTED_PROTOCOLS_MAX_LEN>>,
    /// Every version the daemon speaks, on an incompatible first handshake.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "wire::present"
    )]
    #[schemars(with = "BoundedVec<ProtocolVersion, 0, SUPPORTED_PROTOCOLS_MAX_LEN>")]
    pub daemon_supported_protocols:
        Option<BoundedVec<ProtocolVersion, 0, SUPPORTED_PROTOCOLS_MAX_LEN>>,
}

/// The TypeScript module of the handshake.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "jsonrpc/negotiation",
    doc: "The `daemon.hello` handshake, `DaemonHello` and `DaemonHelloAck`, shared by the daemon \
          and its clients. A `protocolVersion` is an ISO 8601 `YYYY-MM-DD` date, so lexical order \
          is chronological.",
    definitions: &[
        Definition::read::<ProtocolVersion>(),
        Definition::read::<DaemonHello>().checked(),
        Definition::read::<NegotiationIncompatibleReason>(),
        Definition::read::<DaemonHelloAck>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
