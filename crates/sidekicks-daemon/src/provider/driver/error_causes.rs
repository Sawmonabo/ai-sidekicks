//! The typed causes a driver error carries where its caller acts on more than a code: a provider
//! command that names no runnable build, and a request the provider got with no answer back.

use std::io;

use sidekicks_contracts::provider::id::ProviderId;

use crate::ipc::domain_error::DomainError;

/// The configured provider command names no runnable build, or one whose real path cannot be
/// read. It carries the command as the person configured it, never a path they did not type.
#[derive(Debug, thiserror::Error)]
#[error("the provider command {requested_command:?} names no runnable build")]
pub(crate) struct ExecutableUnresolvable {
    /// The provider.
    pub(crate) provider: ProviderId,
    /// The command as configured: a bare name or a path.
    pub(crate) requested_command: String,
    /// Why it resolves to no build: none was found, or its real path could not be read.
    #[source]
    pub(crate) cause: io::Error,
}

/// The request went out to the provider and no answer came back: its deadline passed or the link
/// broke first, so the provider may still act on it. Only the driver knows the request was
/// written; a caller holding what the request carried keeps it until the provider's own record
/// says what became of it, and never sends it again blind.
#[derive(Debug, thiserror::Error)]
#[error("the provider got the request and no answer came: {refusal}")]
pub(crate) struct RequestUnanswered {
    /// The refusal the call answers with, `provider.timeout` or `provider.unavailable`.
    #[source]
    pub(crate) refusal: DomainError,
}
