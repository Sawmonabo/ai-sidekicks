//! A JSON-RPC 2.0 message, as one frame-codec message carries it: a request, a notification, a
//! response or an error response, with its params or result kept unparsed until the method's
//! contract reads them together with the message's attachments.

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::value::RawValue;

use crate::jsonrpc::error_code::JsonRpcErrorCode;
use crate::jsonrpc::refusal::RefusalCode;
use crate::wire;

/// The `jsonrpc` member every message carries.
pub const JSONRPC_VERSION: &str = "2.0";

/// The notification that asks the daemon to stop a call it has not answered; the call still gets
/// exactly one response, `-32800` with `request.canceled` when it stopped before committing.
pub const CANCEL_REQUEST_METHOD: &str = "$/cancelRequest";

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

/// The `data` of an error: the refusal's code and its structured detail, which producers keep
/// free of stack traces, absolute paths and secrets.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JsonRpcErrorData {
    /// The refusal's code; clients branch on it, never on the message.
    #[serde(rename = "type")]
    pub refusal: String,
    /// The refusal's detail.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "wire::present"
    )]
    pub fields: Option<serde_json::Map<String, serde_json::Value>>,
}

/// An error response's `error`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JsonRpcError {
    /// The numeric code that frames the error.
    pub code: i64,
    /// A sentence for a person, sanitized before it leaves the daemon.
    pub message: String,
    /// The refusal's code and detail.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "wire::present"
    )]
    pub data: Option<JsonRpcErrorData>,
}

impl JsonRpcError {
    /// The answer to a call the client canceled before the daemon committed it.
    pub fn request_canceled() -> Self {
        Self {
            code: i64::from(JsonRpcErrorCode::RequestCanceled.code()),
            message: "The call was canceled.".to_owned(),
            data: Some(JsonRpcErrorData {
                refusal: RefusalCode::RequestCanceled.as_str().to_owned(),
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
        /// The protocol version the client negotiated, absent only on `daemon.hello`.
        protocol_version: Option<String>,
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
    protocol_version: Option<String>,
}

/// Why a message's JSON is not a JSON-RPC 2.0 message.
#[derive(Debug, thiserror::Error)]
pub enum MessageError {
    /// The JSON does not parse, or a member has the wrong type (`-32700` or `-32600`).
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    /// The members present form no message kind, or `jsonrpc` is not `2.0` (`-32600`).
    #[error("the JSON is not a JSON-RPC 2.0 message")]
    NotAMessage,
}

impl JsonRpcMessage {
    /// Reads a message's JSON; refuses JSON whose members form no message kind.
    pub fn from_slice(json: &[u8]) -> Result<Self, MessageError> {
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
                envelope.protocol_version = protocol_version.as_deref();
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
    protocol_version: Option<&'a str>,
}

/// The params of [`CANCEL_REQUEST_METHOD`]: the id of the call to stop.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelRequestParams {
    /// The id of the request to stop.
    pub id: JsonRpcId,
}
