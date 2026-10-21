//! The error a method handler raises to refuse a call with a classified code: its refusal code
//! becomes the reply's `data.type`, its category `data.category` and its detail `data.fields`, and
//! the code's table entry gives the number. A failure that is no `DomainError` answers `-32603`
//! with no `data.type`.

use std::error::Error;

use serde::Serialize;
use serde_json::{Map, Value};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;

/// A handler's refusal with its wire form; its `Display` is the message a person reads.
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub(crate) struct DomainError {
    /// What went wrong, in words a person reads.
    pub(crate) message: String,
    /// The refusal code, sent as the reply's `data.type`.
    pub(crate) code: RefusalCode,
    /// Detail from where the refusal was raised, sent as `data.fields` once sanitized.
    pub(crate) detail: Option<Map<String, Value>>,
    /// The failure underneath, kept for the service log and never sent.
    #[source]
    pub(crate) source: Option<Box<dyn Error + Send + Sync>>,
}

impl DomainError {
    /// A refusal with `code`, with no detail and no failure underneath.
    pub(crate) fn new(message: impl Into<String>, code: RefusalCode) -> Self {
        Self {
            message: message.into(),
            code,
            detail: None,
            source: None,
        }
    }

    /// The refusal for a session id that resolves to no session the daemon holds; `details` (the
    /// offending id) go out as the reply's `data.fields`.
    pub(crate) fn session_not_found(message: impl Into<String>, details: impl Serialize) -> Self {
        Self::new(message, RefusalCode::SessionNotFound).with_detail(details)
    }

    /// The same refusal carrying `details`, sent as the reply's `data.fields` once sanitized.
    pub(crate) fn with_detail(self, details: impl Serialize) -> Self {
        Self {
            detail: Some(refusal_fields(details)),
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

    /// The same refusal keeping `source`, the failure underneath, where there is one.
    pub(crate) fn with_optional_source(self, source: Option<Box<dyn Error + Send + Sync>>) -> Self {
        match source {
            Some(source) => self.with_source(source),
            None => self,
        }
    }
}

/// A refusal's `data.fields` from `details`, a contract's details type or a `json!` object, each
/// member as it writes; every refusal's fields are built here. Panics only on details that write
/// no object, which neither form does.
pub(crate) fn refusal_fields(details: impl Serialize) -> Map<String, Value> {
    serde_json::to_value(details)
        .and_then(serde_json::from_value)
        .expect("a refusal's details write an object")
}
