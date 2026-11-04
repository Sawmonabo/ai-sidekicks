//! The answer a governance mutation's receipt keeps once it is committed, which a retry under the
//! same idempotency key gets back: the response it was served, or the refusal it was answered
//! with, kept with its code, message and detail and never the failure underneath.

#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the mutation service saves each answer and replays it on a retry"
    )
)]

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_ipc::domain_error::DomainError;

/// A committed receipt's answer, stored as its `response_json`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "answer", rename_all = "camelCase")]
pub(crate) enum McpSavedAnswer {
    /// The mutation was served this response.
    Served {
        /// The response, as it went on the wire.
        response: Value,
    },
    /// The mutation was refused.
    Refused {
        /// The refusal's code.
        code: RefusalCode,
        /// The refusal's message.
        message: String,
        /// The refusal's detail, sent as `data.fields`; `None` where it had none.
        fields: Option<Map<String, Value>>,
    },
}

impl McpSavedAnswer {
    /// The saved form of `refusal`: its code, message and detail, without its failure underneath.
    pub(crate) fn of_refusal(refusal: &DomainError) -> Self {
        Self::Refused {
            code: refusal.code,
            message: refusal.message.clone(),
            fields: refusal.detail.as_deref().cloned(),
        }
    }

    /// The answer a retry gets: the served response, or the saved refusal as the error it answers
    /// with.
    pub(crate) fn into_domain_error(self) -> Result<Value, DomainError> {
        match self {
            Self::Served { response } => Ok(response),
            Self::Refused {
                code,
                message,
                fields,
            } => Err(DomainError {
                message,
                code,
                detail: fields.map(Box::new),
                source: None,
            }),
        }
    }
}
