//! The error a method handler raises to refuse a call with a classified code: its refusal code
//! becomes the reply's `data.type`, its category `data.category` and its detail `data.fields`, and
//! the code's table entry gives the number. A failure that is no `DomainError` answers `-32603`
//! with no `data.type`.

use std::error::Error;

use serde::Serialize;
use serde_json::{Map, Value};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::keychain::KeychainRefusalCause;
use sidekicks_store::credential_store::KeychainRefusal;
use sidekicks_store::events::log_service::SessionAppendRefusal;

/// A handler's refusal with its wire form; its `Display` is the message a person reads.
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct DomainError {
    /// What went wrong, in words a person reads.
    pub message: String,
    /// The refusal code, sent as the reply's `data.type`.
    pub code: RefusalCode,
    /// Detail from where the refusal was raised, sent as `data.fields` once sanitized.
    pub detail: Option<Map<String, Value>>,
    /// The failure underneath, kept for the service log and never sent.
    #[source]
    pub source: Option<Box<dyn Error + Send + Sync>>,
}

impl DomainError {
    /// A refusal with `code`, with no detail and no failure underneath.
    pub fn new(message: impl Into<String>, code: RefusalCode) -> Self {
        Self {
            message: message.into(),
            code,
            detail: None,
            source: None,
        }
    }

    /// The refusal for a session id that resolves to no session the daemon holds; `details` (the
    /// offending id) go out as the reply's `data.fields`.
    pub fn session_not_found(message: impl Into<String>, details: impl Serialize) -> Self {
        Self::new(message, RefusalCode::SessionNotFound).with_detail(details)
    }

    /// The caller's own refusal `code` for a keychain that could not be used, with the details
    /// `details` builds from its cause, the keychain refusal's text and its failure underneath.
    pub fn keychain_refused<Details: Serialize>(
        refusal: KeychainRefusal,
        code: RefusalCode,
        details: impl FnOnce(KeychainRefusalCause) -> Details,
    ) -> Self {
        let message = refusal.to_string();
        let (cause, failure) = refusal.into_cause_and_failure();
        Self::new(message, code)
            .with_detail(details(cause))
            .with_optional_source(failure)
    }

    /// The same refusal carrying `details`, sent as the reply's `data.fields` once sanitized.
    #[must_use]
    pub fn with_detail(self, details: impl Serialize) -> Self {
        Self {
            detail: Some(refusal_fields(details)),
            ..self
        }
    }

    /// The same refusal keeping `source`, the failure underneath, for the service log.
    #[must_use]
    pub fn with_source(self, source: impl Into<Box<dyn Error + Send + Sync>>) -> Self {
        Self {
            source: Some(source.into()),
            ..self
        }
    }

    /// The same refusal keeping `source`, the failure underneath, where there is one.
    #[must_use]
    pub fn with_optional_source(self, source: Option<Box<dyn Error + Send + Sync>>) -> Self {
        match source {
            Some(source) => self.with_source(source),
            None => self,
        }
    }
}

impl From<SessionAppendRefusal> for DomainError {
    /// A session's refusal of an append, answered with its reason's code, its message and its
    /// details as the fields.
    fn from(refusal: SessionAppendRefusal) -> Self {
        match refusal {
            SessionAppendRefusal::Rebuilding { message, details } => {
                Self::new(message, RefusalCode::SessionRebuilding).with_detail(details)
            }
            SessionAppendRefusal::HistoryDamaged { message, details } => {
                Self::new(message, RefusalCode::SessionHistoryDamaged).with_detail(details)
            }
        }
    }
}

/// A refusal's `data.fields` from `details`, a contract's details type or a `json!` object, each
/// member as it writes; every refusal's fields are built here. Panics only on details that write
/// no object, which neither form does.
pub fn refusal_fields(details: impl Serialize) -> Map<String, Value> {
    serde_json::to_value(details)
        .and_then(serde_json::from_value)
        .expect("a refusal's details write an object")
}
