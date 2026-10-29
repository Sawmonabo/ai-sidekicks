//! A JSON-RPC 2.0 message, as one frame-codec message carries it: a request, a notification, a
//! response or an error response, with its params or result kept unparsed until the method's
//! contract reads them together with the message's attachments.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use serde_json::value::RawValue;

use crate::jsonrpc::byte_length::json_utf8_byte_length;
use crate::jsonrpc::negotiation::CONNECTION_INITIALIZE_METHOD;
use crate::jsonrpc::refusal::RefusalCode;
use crate::jsonrpc::refusal::category::RefusalCategory;
use crate::schema::doc_description;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire;
use crate::wire::integer::SafeSignedInt;
use crate::wire::name::is_protocol_method_name;
use crate::wire::record::JsonRecord;

ts_constants! {
    /// The `jsonrpc` member every message carries.
    pub const JSONRPC_VERSION: &str = "2.0";
    /// The largest JSON-RPC `id`, in bytes once JSON-encoded (a UUID id is 38). A response echoes
    /// its request's `id`, so the gateway refuses a longer one before dispatch.
    pub const JSON_RPC_ID_MAX_BYTES: usize = 256;
    /// The most calls one connection holds in flight; a call past it is refused at once with
    /// `connection.call.limitReached`, and a client holds its calls past it, sending each as a
    /// slot frees. A subscription cancel, a stop and a terminal write take no slot. It changes only
    /// with a new dated protocol version, so a conforming client is never refused.
    pub const MAX_CALLS_IN_FLIGHT: usize = 100;
    /// The refusal a client reports when the daemon cannot be reached: nothing listens on its
    /// socket, or the link to it is down; `fields.reason` says why.
    CONNECTION_UNAVAILABLE_CODE = RefusalCode::ConnectionUnavailable;
}

/// The notification that asks the daemon to stop a call it has not answered; the call still gets
/// exactly one response, `-32800` with `request.canceled` when it stopped before committing.
pub const CANCEL_REQUEST_METHOD: &str = "$/cancelRequest";

const _: () = assert!(
    is_protocol_method_name(CANCEL_REQUEST_METHOD),
    "the cancel method is not a protocol method name",
);

/// The methods that carry no `protocolVersion` on the message: only `connection.initialize`, which
/// carries its versions in its params, since none is negotiated before it.
pub const ENVELOPE_PROTOCOL_VERSION_EXEMPT_METHODS: &[&str] = &[CONNECTION_INITIALIZE_METHOD];

/// A request's `id`: a string, a number or `null`, echoed back by its response.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum JsonRpcId {
    /// A text id.
    String(String),
    /// A numeric id, kept as written.
    Number(serde_json::Number),
    /// The `null` id of a response to a request whose id could not be read.
    Null,
}

impl JsonRpcId {
    /// Whether the id encodes within [`JSON_RPC_ID_MAX_BYTES`] as JSON. Fails only where the id's
    /// own `Serialize` fails.
    pub fn is_within_bound(&self) -> serde_json::Result<bool> {
        Ok(json_utf8_byte_length(self)? <= JSON_RPC_ID_MAX_BYTES)
    }
}

impl JsonSchema for JsonRpcId {
    fn schema_name() -> Cow<'static, str> {
        "JsonRpcId".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "description": "A request's `id`: a string, a number or `null`, echoed back by its \
                            response.",
            "anyOf": [{ "type": "string" }, { "type": "number" }, { "type": "null" }],
        })
    }
}

impl Serialize for JsonRpcId {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::String(text) => serializer.serialize_str(text),
            Self::Number(number) => number.serialize(serializer),
            Self::Null => serializer.serialize_unit(),
        }
    }
}

impl<'de> Deserialize<'de> for JsonRpcId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match serde_json::Value::deserialize(deserializer)? {
            serde_json::Value::String(text) => Ok(Self::String(text)),
            serde_json::Value::Number(number) => Ok(Self::Number(number)),
            serde_json::Value::Null => Ok(Self::Null),
            serde_json::Value::Bool(_)
            | serde_json::Value::Array(_)
            | serde_json::Value::Object(_) => {
                Err(D::Error::custom("an id is a string, a number or null"))
            }
        }
    }
}

/// The `data` of an error: the refusal's code, its category and its structured detail, which
/// producers keep free of stack traces, absolute paths and secrets.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JsonRpcErrorData {
    /// The refusal's code; clients branch on it, never on the message.
    #[serde(rename = "type")]
    pub refusal: String,
    /// The refusal's category, which a client acts on for a code it does not know.
    pub category: RefusalCategory,
    /// The refusal's detail.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "wire::present"
    )]
    #[schemars(with = "JsonRecord")]
    pub fields: Option<JsonRecord>,
}

/// An error response's `error`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JsonRpcError {
    /// The numeric code that frames the error.
    pub code: SafeSignedInt,
    /// A sentence for a person, sanitized before it leaves the daemon.
    pub message: String,
    /// The refusal's code and detail.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "wire::present"
    )]
    #[schemars(with = "JsonRpcErrorData")]
    pub data: Option<JsonRpcErrorData>,
}

impl JsonRpcError {
    /// The answer to a call the client canceled before the daemon committed it.
    pub fn request_canceled() -> Self {
        Self {
            code: SafeSignedInt::new(i64::from(
                RefusalCode::RequestCanceled.json_rpc_code().code(),
            ))
            .expect("a JSON-RPC error code is a safe integer"),
            message: "The call was canceled.".to_owned(),
            data: Some(JsonRpcErrorData {
                refusal: RefusalCode::RequestCanceled.as_str().to_owned(),
                category: RefusalCode::RequestCanceled.category(),
                fields: None,
            }),
        }
    }
}

/// One JSON-RPC 2.0 message.
#[derive(Debug)]
pub enum JsonRpcMessage {
    /// A call that gets exactly one response.
    Request {
        /// The id its response echoes.
        id: JsonRpcId,
        /// The method's wire name.
        method: String,
        /// The params, read later by the method's contract.
        params: Option<Box<RawValue>>,
        /// The protocol version the client negotiated, absent only on `connection.initialize`; any
        /// JSON value as sent, so a wrong type is refused with the request's own id.
        protocol_version: Option<Value>,
    },
    /// A call that gets no response.
    Notification {
        /// The method's wire name.
        method: String,
        /// The params, read later by the method's contract.
        params: Option<Box<RawValue>>,
    },
    /// A request's result.
    Response {
        /// The request's id.
        id: JsonRpcId,
        /// The result, read later by the method's contract.
        result: Box<RawValue>,
    },
    /// A request's error.
    ErrorResponse {
        /// The request's id, `null` where it could not be read.
        id: JsonRpcId,
        /// The error.
        error: JsonRpcError,
    },
}

/// Every member any message may carry; which ones are present decides the message's kind.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    jsonrpc: String,
    #[serde(default, deserialize_with = "wire::present")]
    id: Option<JsonRpcId>,
    #[serde(default, deserialize_with = "wire::present")]
    method: Option<String>,
    #[serde(default, deserialize_with = "wire::present")]
    params: Option<Box<RawValue>>,
    #[serde(default, deserialize_with = "wire::present")]
    result: Option<Box<RawValue>>,
    #[serde(default, deserialize_with = "wire::present")]
    error: Option<JsonRpcError>,
    #[serde(default, deserialize_with = "wire::present")]
    protocol_version: Option<Value>,
}

/// Why a message's JSON is not a JSON-RPC 2.0 message.
#[derive(Debug, thiserror::Error)]
pub enum MessageError {
    /// The JSON does not parse, or a member has the wrong type (`-32700` or `-32600`).
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    /// The JSON is not an object, its members form no message kind, or `jsonrpc` is not `2.0`
    /// (`-32600`).
    #[error("the JSON is not a JSON-RPC 2.0 message")]
    NotAMessage,
}

impl JsonRpcMessage {
    /// Reads a message's JSON; refuses JSON that is not an object or whose members form no message
    /// kind.
    pub fn from_slice(json: &[u8]) -> Result<Self, MessageError> {
        // serde reads a struct from a JSON array too, by position; a message is an object. JSON
        // that does not parse still answers as a parse error.
        if json.trim_ascii_start().first() != Some(&b'{') {
            serde_json::from_slice::<serde::de::IgnoredAny>(json)?;
            return Err(MessageError::NotAMessage);
        }
        let envelope: Envelope = serde_json::from_slice(json)?;
        if envelope.jsonrpc != JSONRPC_VERSION {
            return Err(MessageError::NotAMessage);
        }
        match envelope {
            Envelope {
                id,
                method: Some(method),
                params,
                result: None,
                error: None,
                protocol_version,
                ..
            } => Ok(match id {
                Some(id) => Self::Request {
                    id,
                    method,
                    params,
                    protocol_version,
                },
                None if protocol_version.is_none() => Self::Notification { method, params },
                None => return Err(MessageError::NotAMessage),
            }),
            Envelope {
                id: Some(id),
                method: None,
                params: None,
                result: Some(result),
                error: None,
                protocol_version: None,
                ..
            } => Ok(Self::Response { id, result }),
            Envelope {
                id: Some(id),
                method: None,
                params: None,
                result: None,
                error: Some(error),
                protocol_version: None,
                ..
            } => Ok(Self::ErrorResponse { id, error }),
            Envelope { .. } => Err(MessageError::NotAMessage),
        }
    }

    /// Writes the message's JSON. Fails only where a member's own `Serialize` fails.
    pub fn to_vec(&self) -> serde_json::Result<Vec<u8>> {
        let mut envelope = OutgoingEnvelope {
            jsonrpc: JSONRPC_VERSION,
            ..OutgoingEnvelope::default()
        };
        match self {
            Self::Request {
                id,
                method,
                params,
                protocol_version,
            } => {
                envelope.id = Some(id);
                envelope.method = Some(method.as_str());
                envelope.params = params.as_deref();
                envelope.protocol_version = protocol_version.as_ref();
            }
            Self::Notification { method, params } => {
                envelope.method = Some(method.as_str());
                envelope.params = params.as_deref();
            }
            Self::Response { id, result } => {
                envelope.id = Some(id);
                envelope.result = Some(&**result);
            }
            Self::ErrorResponse { id, error } => {
                envelope.id = Some(id);
                envelope.error = Some(error);
            }
        }
        serde_json::to_vec(&envelope)
    }
}

/// The members of a message being written, borrowed from it.
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutgoingEnvelope<'a> {
    jsonrpc: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<&'a JsonRpcId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    method: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<&'a RawValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<&'a RawValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a JsonRpcError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    protocol_version: Option<&'a Value>,
}

/// Declares the JSON Schema of each kind of message, for TypeScript's types; each type is only
/// its kind's schema and is never a value.
macro_rules! message_kind_schemas {
    ($(
        $(#[doc = $doc:literal])+
        $marker:ident = $name:literal |$generator:ident| $schema:tt;
    )+) => {$(
        $(#[doc = $doc])+
        pub struct $marker;

        impl JsonSchema for $marker {
            fn schema_name() -> Cow<'static, str> {
                $name.into()
            }

            fn json_schema($generator: &mut SchemaGenerator) -> Schema {
                let mut schema = json_schema!($schema);
                schema.insert(
                    "description".into(),
                    doc_description(concat!($($doc, "\n"),+)).into(),
                );
                schema
            }
        }
    )+};
}

message_kind_schemas! {
    /// A JSON-RPC 2.0 request: a call that gets exactly one response. `protocolVersion` is absent
    /// only on `connection.initialize`.
    JsonRpcRequestSchema = "JsonRpcRequest" |generator| {
        "type": "object",
        "properties": {
            "jsonrpc": { "const": JSONRPC_VERSION },
            "id": generator.subschema_for::<JsonRpcId>(),
            "method": { "type": "string" },
            "params": true,
            "protocolVersion": { "type": "string" },
        },
        "required": ["jsonrpc", "id", "method"],
        "additionalProperties": false,
    };
    /// A JSON-RPC 2.0 notification: a call with no `id`, which gets no response.
    JsonRpcNotificationSchema = "JsonRpcNotification" |_generator| {
        "type": "object",
        "properties": {
            "jsonrpc": { "const": JSONRPC_VERSION },
            "method": { "type": "string" },
            "params": true,
        },
        "required": ["jsonrpc", "method"],
        "additionalProperties": false,
    };
    /// A JSON-RPC 2.0 success response; `id` is its request's.
    JsonRpcResponseSchema = "JsonRpcResponse" |generator| {
        "type": "object",
        "properties": {
            "jsonrpc": { "const": JSONRPC_VERSION },
            "id": generator.subschema_for::<JsonRpcId>(),
            "result": true,
        },
        "required": ["jsonrpc", "id", "result"],
        "additionalProperties": false,
    };
    /// A JSON-RPC 2.0 error response; `id` is `null` where the request's id could not be read.
    JsonRpcErrorResponseSchema = "JsonRpcErrorResponse" |generator| {
        "type": "object",
        "properties": {
            "jsonrpc": { "const": JSONRPC_VERSION },
            "id": generator.subschema_for::<JsonRpcId>(),
            "error": generator.subschema_for::<JsonRpcError>(),
        },
        "required": ["jsonrpc", "id", "error"],
        "additionalProperties": false,
    };
    /// A response: a success or an error, never both.
    JsonRpcResponseEnvelopeSchema = "JsonRpcResponseEnvelope" |generator| {
        "anyOf": [
            generator.subschema_for::<JsonRpcResponseSchema>(),
            generator.subschema_for::<JsonRpcErrorResponseSchema>(),
        ],
    };
    /// What a client receives from the daemon: a response or a notification, and nothing else.
    JsonRpcServerMessageSchema = "JsonRpcServerMessage" |generator| {
        "anyOf": [
            generator.subschema_for::<JsonRpcResponseSchema>(),
            generator.subschema_for::<JsonRpcErrorResponseSchema>(),
            generator.subschema_for::<JsonRpcNotificationSchema>(),
        ],
    };
}

impl JsonSchema for JsonRpcMessage {
    fn schema_name() -> Cow<'static, str> {
        "JsonRpcMessage".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "description": "One JSON-RPC 2.0 message: a request, a notification or a response.",
            "anyOf": [
                generator.subschema_for::<JsonRpcRequestSchema>(),
                generator.subschema_for::<JsonRpcNotificationSchema>(),
                generator.subschema_for::<JsonRpcResponseEnvelopeSchema>(),
            ],
        })
    }
}

/// Why a request's `protocolVersion` is refused, the `fields.reason` of
/// `request.protocolVersion.invalid`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ProtocolVersionInvalidReason {
    /// The request carries no `protocolVersion`.
    Missing,
    /// The member is present but no string, `null` included.
    WrongType,
    /// The member is a string but no `YYYY-MM-DD` date.
    InvalidFormat,
}

/// A refused value's JSON type, named so the value itself is never echoed: `object` for an object
/// or an array.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ObservedType {
    /// `null`.
    Null,
    /// An object or an array.
    Object,
    /// `true` or `false`.
    Boolean,
    /// A number.
    Number,
    /// A string.
    String,
}

impl ObservedType {
    /// The JSON type of `value`.
    pub const fn of(value: &Value) -> Self {
        match value {
            Value::Null => Self::Null,
            Value::Object(_) | Value::Array(_) => Self::Object,
            Value::Bool(_) => Self::Boolean,
            Value::Number(_) => Self::Number,
            Value::String(_) => Self::String,
        }
    }
}

/// The `request.protocolVersion.invalid` refusal's `data.fields`: why, and for a wrong type the
/// value's JSON type, never the value.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProtocolVersionInvalidDetails {
    /// Why the member is refused.
    pub reason: ProtocolVersionInvalidReason,
    /// The member's JSON type, present only when `reason` is `wrongType`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "wire::present"
    )]
    #[schemars(with = "ObservedType")]
    pub observed_type: Option<ObservedType>,
}

/// Why a socket cannot reach the daemon, the `fields.reason` of `connection.unavailable`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionUnavailableReason {
    /// Nobody answers on the socket (`ENOENT` or `ECONNREFUSED`).
    NotListening,
    /// The client may not open the socket (`EACCES` or `EPERM`).
    AccessDenied,
    /// Any other socket failure.
    Unreachable,
}

/// The TypeScript module of the message and its error.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "jsonrpc/message",
    doc: "JSON-RPC 2.0 messages shared by the daemon and its clients: the kinds of message, the \
          error a response carries, the bound on a request's id, the calls a connection holds in \
          flight and why a request's protocol version is refused.",
    definitions: &[
        Definition::read::<JsonRpcId>(),
        Definition::read::<JsonRpcErrorData>(),
        Definition::read::<JsonRpcError>(),
        Definition::read::<JsonRpcRequestSchema>(),
        Definition::read::<JsonRpcNotificationSchema>(),
        Definition::read::<JsonRpcResponseSchema>(),
        Definition::read::<JsonRpcErrorResponseSchema>(),
        Definition::read::<JsonRpcResponseEnvelopeSchema>(),
        Definition::read::<JsonRpcMessage>(),
        Definition::read::<JsonRpcServerMessageSchema>().checked(),
        Definition::read::<ConnectionUnavailableReason>(),
        Definition::read::<ProtocolVersionInvalidReason>(),
        Definition::read::<ObservedType>(),
        Definition::read::<ProtocolVersionInvalidDetails>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};

/// The params of [`CANCEL_REQUEST_METHOD`]: the id of the call to stop, read with
/// [`crate::wire::attachment::parse_received`] like every other received message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelRequestParams {
    /// The id of the request to stop.
    #[garde(skip)]
    pub id: JsonRpcId,
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::{JsonRpcMessage, MessageError};

    #[rstest]
    #[case::an_array_by_position(br#"["2.0", 1, "session.read", null, null, null, null]"#, false)]
    #[case::text_that_does_not_parse(br#"["2.0", "#, true)]
    fn a_message_that_is_not_an_object_is_refused(
        #[case] json: &[u8],
        #[case] is_parse_error: bool,
    ) {
        let refusal = JsonRpcMessage::from_slice(json).expect_err("a non-object is refused");
        assert_eq!(matches!(refusal, MessageError::Json(_)), is_parse_error);
    }
}
