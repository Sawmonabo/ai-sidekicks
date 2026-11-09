//! Why a session's process could not be brought up and adopted, the recovery a failed resume
//! leaves the session in, and the refusal or internal failure each failure answers a caller as.

use std::error::Error;
use std::io;

use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_std::port_registration::PortRegistrationError;
use sidekicks_store::events::canonicalizer::CanonicalizationRefusal;

use super::context::ClaudeSpawnContextError;
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::session::errors::ClaudeSessionError;
use crate::driver::claude::spawn::launch::ClaudeLaunchError;
use crate::driver::claude::spawn::legs::ClaudeSpawnLegsError;
use crate::driver::contract::error::DriverError;
use crate::driver::error_causes::{ProviderAxisInvalid, provider_failure_refusal};

/// Why a session's process could not be brought up and adopted.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ClaudeEstablishmentError {
    /// The session refused the operation, or its process failed a request.
    #[error(transparent)]
    Session(#[from] ClaudeSessionError),
    /// The process could not be started or brought up.
    #[error(transparent)]
    Launch(#[from] ClaudeLaunchError),
    /// The session's spawn context could not be resolved.
    #[error(transparent)]
    Context(#[from] ClaudeSpawnContextError),
    /// The legs the process starts with could not be built.
    #[error(transparent)]
    Legs(#[from] ClaudeSpawnLegsError),
    /// The session's standing rules could not be read.
    #[error("the session's standing rules could not be read")]
    SessionRules(#[source] Box<dyn Error + Send + Sync>),
    /// The tool calls the session's log holds in the background could not be read.
    #[error("the session's held tool calls could not be read")]
    HeldToolCalls(#[source] Box<dyn Error + Send + Sync>),
    /// The advisor Claude Code resolved could not be kept as the session's own.
    #[error("the session's resolved advisor could not be kept")]
    AdvisorRecord(#[source] Box<dyn Error + Send + Sync>),
    /// The output schema has no canonical form to bind.
    #[error("the session's output schema has no canonical form")]
    OutputSchema(#[from] CanonicalizationRefusal),
    /// A handle the daemon registers after the drivers is not registered yet.
    #[error(transparent)]
    Port(#[from] PortRegistrationError),
    /// The session's binding could not be pointed at the conversation it moved onto.
    #[error("the session's binding could not be pointed at its new conversation")]
    Rebind(#[source] Box<dyn Error + Send + Sync>),
    /// The resumed conversation's file could not be found or read.
    #[error("the conversation {resume_handle} could not be read")]
    ConversationUnreadable {
        /// Claude Code's id of the conversation.
        resume_handle: String,
        /// The read that failed.
        #[source]
        source: io::Error,
    },
    /// A close took the session's slot while its process came up, so the process was ended.
    #[error("the session was closed while its Claude Code process came up")]
    Closed,
    /// Claude Code cannot run the session at its level on its model or this system
    /// (`session.permissionLevel.notOffered`), so the process was ended.
    #[error(transparent)]
    LevelNotOffered(DomainError),
    /// The lead asked for a value on a provider axis the started process does not offer
    /// (`agent.providerAxisInvalid`), so the process was ended.
    #[error(transparent)]
    AxisNotOffered(ProviderAxisInvalid),
    /// The session's command channel could not be opened.
    #[error("the session's command channel could not be opened")]
    CommandChannel(#[source] io::Error),
    /// The repository of the session's working folder, which places its project settings, could
    /// not be read (`repoMount.rootResolutionFailed` with the read's reason).
    #[error(transparent)]
    RepositoryUnreadable(DomainError),
}

impl ClaudeEstablishmentError {
    // A refused sign-in needs a sign-in again; anything else needs recovering.
    pub(super) fn recovery_condition(&self) -> RecoveryCondition {
        match self {
            Self::Session(error) | Self::Launch(ClaudeLaunchError::Session(error)) => {
                error.recovery_condition()
            }
            Self::Launch(_)
            | Self::Context(_)
            | Self::Legs(_)
            | Self::SessionRules(_)
            | Self::HeldToolCalls(_)
            | Self::AdvisorRecord(_)
            | Self::OutputSchema(_)
            | Self::Port(_)
            | Self::Rebind(_)
            | Self::ConversationUnreadable { .. }
            | Self::Closed
            | Self::LevelNotOffered(_)
            | Self::AxisNotOffered(_)
            | Self::CommandChannel(_)
            | Self::RepositoryUnreadable(_) => RecoveryCondition::RecoveryNeeded,
        }
    }
}

impl From<ClaudeEstablishmentError> for DriverError {
    /// A session's refusal or a launch failure answers as its own, a level the session cannot run
    /// as `session.permissionLevel.notOffered`, an axis value the process does not offer as
    /// `agent.providerAxisInvalid`, a port not registered yet as `provider.unavailable` with the
    /// port's words; anything else is internal.
    fn from(error: ClaudeEstablishmentError) -> Self {
        match error {
            ClaudeEstablishmentError::Session(error) => error.into(),
            ClaudeEstablishmentError::Launch(error) => error.into(),
            ClaudeEstablishmentError::LevelNotOffered(refusal)
            | ClaudeEstablishmentError::RepositoryUnreadable(refusal) => Self::from(refusal),
            ClaudeEstablishmentError::AxisNotOffered(invalid) => Self::from(invalid),
            error @ ClaudeEstablishmentError::Port(PortRegistrationError::NotRegistered(_)) => {
                Self::from(provider_failure_refusal(
                    &DESCRIPTOR.provider_id(),
                    "A service the Claude Code process needs is not ready",
                    RefusalCode::ProviderUnavailable,
                    error,
                ))
            }
            error @ (ClaudeEstablishmentError::Context(_)
            | ClaudeEstablishmentError::Legs(_)
            | ClaudeEstablishmentError::SessionRules(_)
            | ClaudeEstablishmentError::HeldToolCalls(_)
            | ClaudeEstablishmentError::AdvisorRecord(_)
            | ClaudeEstablishmentError::OutputSchema(_)
            | ClaudeEstablishmentError::Port(PortRegistrationError::AlreadyRegistered(
                _,
            ))
            | ClaudeEstablishmentError::Rebind(_)
            | ClaudeEstablishmentError::ConversationUnreadable { .. }
            | ClaudeEstablishmentError::Closed
            | ClaudeEstablishmentError::CommandChannel(_)) => Self::Internal(Box::new(error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_ipc::registry::HandlerError;
    use sidekicks_std::port_registration::PortRegistrationError;

    use super::ClaudeEstablishmentError;
    use crate::driver::contract::error::DriverError;

    // Killed by answering a port not registered yet as an internal failure, by answering it with
    // another code, or by dropping the port's words from the refusal's detail.
    #[test]
    fn a_port_not_registered_yet_refuses_as_provider_unavailable_with_its_words() {
        let error = ClaudeEstablishmentError::Port(PortRegistrationError::NotRegistered(
            "callback tool host",
        ));

        let HandlerError::Refused(refusal) = HandlerError::from(DriverError::from(error)) else {
            panic!("a port not registered yet answers a refusal");
        };

        assert_eq!(refusal.code, RefusalCode::ProviderUnavailable);
        let detail = refusal.detail.expect("the refusal carries its detail");
        assert_eq!(
            detail.get("providerFailureDetail").and_then(Value::as_str),
            Some("the callback tool host port is not registered yet")
        );
    }
}
