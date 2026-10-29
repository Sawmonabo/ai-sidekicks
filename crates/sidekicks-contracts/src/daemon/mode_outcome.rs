//! What a mode of the daemon's own program answers the command line that started it: one JSON
//! object on its standard output, the mode's result or its refusal in the shape the socket answers
//! one, so the command line reads a mode's refusal the way it reads the service's.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::jsonrpc::error_code::JsonRpcErrorCode;
use crate::jsonrpc::message::{JsonRpcError, JsonRpcErrorData};
use crate::jsonrpc::refusal::RefusalCode;
use crate::wire::AnyValue;
use crate::wire::integer::SafeSignedInt;
use crate::wire::record::JsonRecord;

/// A mode's answer, `{"result": …}` or `{"error": …}` as a JSON-RPC response carries them; the
/// mode exits 0 with a result and 1 with an error.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum DaemonModeOutcome<T> {
    /// What the mode did.
    Result(T),
    /// Why it did not: a refusal with its code, or an internal failure with no `data`.
    Error(JsonRpcError),
}

impl<T> DaemonModeOutcome<T> {
    /// The refusal `code` with `message` for a person and `fields` as its `data.fields`.
    pub fn refused(code: RefusalCode, message: String, fields: BTreeMap<String, AnyValue>) -> Self {
        Self::Error(JsonRpcError {
            code: json_rpc_code(code.json_rpc_code()),
            message,
            data: Some(JsonRpcErrorData {
                refusal: code.as_str().to_owned(),
                category: code.category(),
                fields: JsonRecord::new(fields).filter(|record| !record.as_map().is_empty()),
            }),
        })
    }

    /// A failure inside the mode: `-32603` with `message` and no `data`.
    pub fn failed(message: String) -> Self {
        Self::Error(JsonRpcError {
            code: json_rpc_code(JsonRpcErrorCode::InternalError),
            message,
            data: None,
        })
    }
}

// The error's numeric code as the wire carries it.
fn json_rpc_code(code: JsonRpcErrorCode) -> SafeSignedInt {
    SafeSignedInt::new(i64::from(code.code())).expect("a JSON-RPC error code is a safe integer")
}
