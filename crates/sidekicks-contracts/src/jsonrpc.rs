//! JSON-RPC 2.0: the message, error codes, negotiation, streaming, paging and byte lengths.

use crate::typescript::TypeScriptModule;

pub mod error_code;
pub mod framing;
pub mod message;
pub mod refusal;

/// The topic's TypeScript modules.
pub(crate) const TYPESCRIPT_MODULES: &[&TypeScriptModule] = &[
    &error_code::TYPESCRIPT_MODULE,
    &framing::TYPESCRIPT_MODULE,
    &refusal::TYPESCRIPT_MODULE,
];
