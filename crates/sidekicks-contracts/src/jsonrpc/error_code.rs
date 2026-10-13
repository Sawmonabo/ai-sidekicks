//! The numeric codes of a JSON-RPC error: the five JSON-RPC 2.0 reserves and the canceled call's.
//! A domain refusal rides in `error.data.type`; the number only frames the error.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::typescript::{Definition, TypeScriptModule, ts_constants};

/// A JSON-RPC error's numeric `code`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum JsonRpcErrorCode {
    /// The message is not valid JSON.
    ParseError,
    /// The JSON is not a valid JSON-RPC request.
    InvalidRequest,
    /// No method of that name is registered.
    MethodNotFound,
    /// The params failed the method's contract check.
    InvalidParams,
    /// The daemon failed: a handler's unexpected error or a result that failed its own check.
    InternalError,
    /// The client canceled the call with `$/cancelRequest` before the daemon committed it; its
    /// `data.type` is `request.canceled`.
    RequestCanceled,
}

impl JsonRpcErrorCode {
    /// Every code, in the order TypeScript lists them.
    pub const ALL: [Self; 6] = [
        Self::ParseError,
        Self::InvalidRequest,
        Self::MethodNotFound,
        Self::InvalidParams,
        Self::InternalError,
        Self::RequestCanceled,
    ];

    /// The code's number on the wire.
    pub const fn code(self) -> i32 {
        match self {
            Self::ParseError => -32_700,
            Self::InvalidRequest => -32_600,
            Self::MethodNotFound => -32_601,
            Self::InvalidParams => -32_602,
            Self::InternalError => -32_603,
            Self::RequestCanceled => -32_800,
        }
    }

    /// The code's name, as TypeScript keys it.
    pub const fn name(self) -> &'static str {
        match self {
            Self::ParseError => "ParseError",
            Self::InvalidRequest => "InvalidRequest",
            Self::MethodNotFound => "MethodNotFound",
            Self::InvalidParams => "InvalidParams",
            Self::InternalError => "InternalError",
            Self::RequestCanceled => "RequestCanceled",
        }
    }

    /// The code `number` is, if it is one of these.
    pub fn from_code(number: i64) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|code| i64::from(code.code()) == number)
    }

    /// The codes as TypeScript's `JsonRpcErrorCode` object, name to number.
    fn table() -> serde_json::Map<String, serde_json::Value> {
        Self::ALL
            .into_iter()
            .map(|code| (code.name().to_owned(), code.code().into()))
            .collect()
    }
}

impl Serialize for JsonRpcErrorCode {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_i32(self.code())
    }
}

impl<'de> Deserialize<'de> for JsonRpcErrorCode {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let number = i64::deserialize(deserializer)?;
        Self::from_code(number)
            .ok_or_else(|| D::Error::custom(format!("{number} is not a JSON-RPC error code")))
    }
}

impl JsonSchema for JsonRpcErrorCode {
    fn schema_name() -> Cow<'static, str> {
        "JsonRpcErrorCodeValue".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        let codes: Vec<i32> = Self::ALL.into_iter().map(Self::code).collect();
        json_schema!({
            "description": "A JSON-RPC error's numeric code.",
            "type": "integer",
            "enum": codes,
        })
    }
}

ts_constants! {
    /// The numeric codes of a JSON-RPC error, by name; a domain refusal rides in
    /// `error.data.type`.
    JsonRpcErrorCode = JsonRpcErrorCode::table();
}

/// The TypeScript module of the numeric codes.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "jsonrpc/error-code",
    doc: "The numeric codes of a JSON-RPC error. They build no check, so code that only raises or \
          reads an error loads no schema library.",
    definitions: &[Definition::read::<JsonRpcErrorCode>()],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
