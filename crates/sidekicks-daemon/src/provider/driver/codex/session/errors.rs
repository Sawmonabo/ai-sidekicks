//! The errors the Codex driver raises: transport, size, timeout, provider, rewind-boundary, slot
//! and configuration failures, and how each reaches the daemon as a driver error.

use std::error::Error;
use std::time::Duration;

use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::ipc::domain_error::DomainError;
use crate::provider::driver::capabilities::DriverCapabilityFlag;
use crate::provider::driver::codex::DESCRIPTOR;
use crate::provider::driver::contract::{
    DriverError, PROVIDER_CAPABILITY_UNSUPPORTED_MESSAGE, bound_failure_detail,
};
use crate::provider::driver::error_causes::{
    UNSPECIFIED_PROVIDER_FAILURE_DETAIL, provider_failure_refusal,
};
use crate::provider::driver::registry::provider_capability_refused;

/// The request that forks a conversation, the one whose boundary member a build may refuse.
const THREAD_FORK_METHOD: &str = "thread/fork";

/// The fork's boundary member, the turn the fork keeps up to.
const REWIND_BOUNDARY_FIELD: &str = "lastTurnId";

/// The refusal phrases that name a field rather than a method: a missing parameter and an
/// undeclared one. `unknown variant` is left out because it names a method.
const FIELD_LEVEL_REFUSAL_PHRASES: &[&str] = &["missing field", "unknown field"];

/// Which state holds a session's slot when a create is refused; a create is refused in all three,
/// since a second start would orphan a process.
#[expect(
    dead_code,
    reason = "the Codex session slots refuse a second create in the state they hold"
)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CodexSessionSlotState {
    /// A live session holds the slot.
    Live,
    /// A create or resume is in flight.
    Establishing,
    /// The session is still being torn down.
    Closing,
}

impl CodexSessionSlotState {
    // The words of a create refused while the slot is in this state.
    fn create_refusal(self, session_id: &SessionId) -> String {
        match self {
            Self::Live => format!(
                "A live Codex session is already bound to \"{session_id}\"; create would orphan \
                 it."
            ),
            Self::Establishing => format!(
                "A create or resume for Codex session \"{session_id}\" is already in flight; \
                 create would orphan whichever process loses."
            ),
            Self::Closing => format!(
                "Codex session \"{session_id}\" is still being torn down; create would start a \
                 replacement beside a process that is still exiting."
            ),
        }
    }
}

/// A failure of the Codex driver, keeping its cause; `DriverError::from` turns each into the
/// refusal a client reads or an internal failure.
#[expect(
    dead_code,
    reason = "the Codex transport, connection and session raise these as they fail"
)]
#[derive(Debug, thiserror::Error)]
pub(crate) enum CodexError {
    /// The service's socket or process failed, or the service refused the session.
    #[error("{detail}")]
    Transport {
        /// What failed, in words.
        detail: String,
        /// The failure underneath, when there is one.
        #[source]
        cause: Option<Box<dyn Error + Send + Sync>>,
    },
    /// A request larger than the service takes in one message, refused before it was sent, since
    /// Codex closes the socket on a message past that limit; nothing reached the provider.
    #[error(
        "The \"{method}\" request is {encoded_bytes} bytes, past the {limit} the Codex service \
         takes in one message, so it was not sent."
    )]
    RequestTooLarge {
        /// The request's method.
        method: String,
        /// The encoded request's size, in bytes.
        encoded_bytes: usize,
        /// The most the service takes in one message, in bytes.
        limit: usize,
    },
    /// A request outlived its deadline.
    #[error("The Codex service did not answer \"{method}\" within {timeout:?}.")]
    RequestTimeout {
        /// The request's method.
        method: String,
        /// How long the request waited.
        timeout: Duration,
    },
    /// The service answered a request with a JSON-RPC error.
    #[error("Codex app-server rejected \"{method}\": {message}")]
    ProviderRequest {
        /// The request's method.
        method: String,
        /// The error answer's code.
        code: i64,
        /// The error answer's message, as the service wrote it.
        message: String,
    },
    /// The build takes `thread/fork` but refuses its boundary member, which the static rollback
    /// flag cannot see, since a build the driver admits may predate it.
    #[error("{}", PROVIDER_CAPABILITY_UNSUPPORTED_MESSAGE)]
    RewindBoundaryUnsupported {
        /// The service's refusal, bounded as a failure detail.
        provider_failure_detail: FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>,
    },
    /// A wait on a session's turns that the session's close ended: none of its turns will end
    /// now.
    #[error("Codex session \"{session_id}\" closed while a request waited on its turns.")]
    SessionClosed {
        /// The session that closed.
        session_id: SessionId,
    },
    /// A create for a session whose slot is already held: a caller-sequencing defect.
    #[error("{}", .holder_state.create_refusal(.session_id))]
    SessionAlreadyLive {
        /// The session.
        session_id: SessionId,
        /// The state the slot is held in.
        holder_state: CodexSessionSlotState,
    },
    /// The driver's configuration lacks the shape the driver needs: a wiring defect.
    #[error("the Codex driver's {field} configuration is unusable: {detail}")]
    DriverConfig {
        /// The configuration field at fault.
        field: String,
        /// What is wrong with it.
        detail: String,
        /// The failure underneath, when one was read.
        #[source]
        cause: Option<Box<dyn Error + Send + Sync>>,
    },
}

/// Turns a refused `thread/fork` that names the rewind boundary member into
/// `RewindBoundaryUnsupported`, the service's words bounded as a failure detail; any other error
/// is returned unchanged.
#[expect(
    dead_code,
    reason = "the Codex rewind classifies a refused fork before it reports the failure"
)]
pub(crate) fn classify_rewind_fork_failure(error: CodexError) -> CodexError {
    if let CodexError::ProviderRequest {
        method, message, ..
    } = &error
        && method == THREAD_FORK_METHOD
        && refusal_names_rewind_boundary_field(message)
    {
        return CodexError::RewindBoundaryUnsupported {
            provider_failure_detail: bound_failure_detail(
                message,
                UNSPECIFIED_PROVIDER_FAILURE_DETAIL.clone(),
            ),
        };
    }
    error
}

// Whether the service's refusal names the boundary member as missing or undeclared.
fn refusal_names_rewind_boundary_field(provider_message: &str) -> bool {
    FIELD_LEVEL_REFUSAL_PHRASES
        .iter()
        .any(|phrase| provider_message.contains(&format!("{phrase} `{REWIND_BOUNDARY_FIELD}`")))
}

impl From<CodexError> for DriverError {
    /// A transport failure and an over-large request answer `provider.unavailable` and a timeout
    /// `provider.timeout`, each with the failure's words bounded as `providerFailureDetail`; a
    /// refused fork boundary answers `provider.capability.unsupported` on the rollback flag with
    /// Codex's refusal bounded as `providerFailureDetail`, and a session closed under a wait
    /// `session.alreadyClosed`; the rest are internal failures.
    fn from(error: CodexError) -> Self {
        match &error {
            CodexError::Transport { .. } => Self::Refused(provider_failure_refusal(
                &DESCRIPTOR.provider_id(),
                "The Codex service failed",
                RefusalCode::ProviderUnavailable,
                error,
            )),
            CodexError::RequestTooLarge { .. } => Self::Refused(provider_failure_refusal(
                &DESCRIPTOR.provider_id(),
                "The request is larger than the Codex service takes in one message",
                RefusalCode::ProviderUnavailable,
                error,
            )),
            CodexError::RequestTimeout { .. } => Self::Refused(provider_failure_refusal(
                &DESCRIPTOR.provider_id(),
                "The Codex service did not answer in time",
                RefusalCode::ProviderTimeout,
                error,
            )),
            CodexError::RewindBoundaryUnsupported {
                provider_failure_detail,
            } => {
                let refusal = provider_capability_refused(
                    &DESCRIPTOR.provider_id(),
                    DriverCapabilityFlag::Rollback,
                    provider_failure_detail,
                );
                Self::Refused(refusal.with_source(error))
            }
            CodexError::SessionClosed { session_id } => {
                let session_id = *session_id;
                Self::Refused(
                    DomainError::new(error.to_string(), RefusalCode::SessionAlreadyClosed)
                        .with_detail(json!({ "sessionId": session_id }))
                        .with_source(error),
                )
            }
            CodexError::ProviderRequest { .. }
            | CodexError::SessionAlreadyLive { .. }
            | CodexError::DriverConfig { .. } => Self::Internal(Box::new(error)),
        }
    }
}
