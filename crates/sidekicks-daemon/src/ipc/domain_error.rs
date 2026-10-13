//! The error a method handler raises to refuse a call with a classified code: its refusal code
//! becomes the reply's `data.type`, its detail `data.fields`, and its JSON-RPC code the numeric.
//! A failure that is no `DomainError` answers `-32603` with no `data.type`.

use std::error::Error;

use serde_json::{Map, Value};
use sidekicks_contracts::jsonrpc::error_code::JsonRpcErrorCode;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;

/// The JSON-RPC numerics a domain error may answer with; parse and method-not-found belong to
/// framing and the method table, never to a handler's refusal.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum DomainErrorJsonRpcCode {
    /// Well-formed JSON-RPC that breaks a protocol-state or shape rule.
    InvalidRequest,
    /// An id the call supplies resolves to nothing, as a missing session does.
    InvalidParams,
    /// Any other refusal.
    #[default]
    InternalError,
}

impl From<DomainErrorJsonRpcCode> for JsonRpcErrorCode {
    fn from(code: DomainErrorJsonRpcCode) -> Self {
        match code {
            DomainErrorJsonRpcCode::InvalidRequest => Self::InvalidRequest,
            DomainErrorJsonRpcCode::InvalidParams => Self::InvalidParams,
            DomainErrorJsonRpcCode::InternalError => Self::InternalError,
        }
    }
}

/// A handler's refusal with its wire form; its `Display` is the message a person reads.
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub(crate) struct DomainError {
    /// What went wrong, in words a person reads.
    pub(crate) message: String,
    /// The refusal code, sent as the reply's `data.type`.
    pub(crate) code: RefusalCode,
    /// The reply's numeric `error.code`.
    pub(crate) json_rpc_code: DomainErrorJsonRpcCode,
    /// Detail from where the refusal was raised, sent as `data.fields` once sanitized.
    pub(crate) detail: Option<Map<String, Value>>,
    /// The failure underneath, kept for the service log and never sent.
    #[source]
    pub(crate) source: Option<Box<dyn Error + Send + Sync>>,
}

impl DomainError {
    /// A refusal with `code`, answering `json_rpc_code`, with no detail and no failure underneath.
    pub(crate) fn new(
        message: impl Into<String>,
        code: RefusalCode,
        json_rpc_code: DomainErrorJsonRpcCode,
    ) -> Self {
        Self {
            message: message.into(),
            code,
            json_rpc_code,
            detail: None,
            source: None,
        }
    }

    /// The refusal for a session id that resolves to no session the daemon holds: the id is a bad
    /// parameter, and `fields` (the offending id) goes out as the reply's `data.fields`.
    pub(crate) fn session_not_found(
        message: impl Into<String>,
        fields: Option<Map<String, Value>>,
    ) -> Self {
        Self {
            detail: fields,
            ..Self::new(
                message,
                RefusalCode::SessionNotFound,
                DomainErrorJsonRpcCode::InvalidParams,
            )
        }
    }

    /// The same refusal carrying `detail`, sent as the reply's `data.fields` once sanitized.
    pub(crate) fn with_detail(self, detail: Map<String, Value>) -> Self {
        Self {
            detail: Some(detail),
            ..self
        }
    }

    /// The same refusal keeping `source`, the failure underneath, for the service log.
    pub(crate) fn with_source(self, source: impl Into<Box<dyn Error + Send + Sync>>) -> Self {
        Self {
            source: Some(source.into()),
            ..self
        }
    }
}
