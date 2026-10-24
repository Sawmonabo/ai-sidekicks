//! The errors the Codex driver raises: transport, size, unanswered, provider, rewind-boundary,
//! slot, turn-in-flight, withdrawn-turn, larger-window, port, driver-shaped and configuration
//! failures, and how each reaches the daemon as a driver error; and the readers of Codex's
//! active-writer and restart refusals.

use std::error::Error;
use std::time::Duration;

use serde_json::{Value, json};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::ipc::domain_error::DomainError;
use crate::provider::driver::capabilities::DriverCapabilityFlag;
use crate::provider::driver::codex::DESCRIPTOR;
use crate::provider::driver::contract::{
    DriverError, PROVIDER_CAPABILITY_UNSUPPORTED_MESSAGE, bound_failure_detail,
};
use crate::provider::driver::error_causes::{
    RequestUnanswered, UNSPECIFIED_PROVIDER_FAILURE_DETAIL, provider_failure_refusal,
};
use crate::provider::driver::registry::provider_capability_refused;

/// The request that forks a conversation, the one whose boundary member a build may refuse.
const THREAD_FORK_METHOD: &str = "thread/fork";

/// The fork's boundary member, the turn the fork keeps up to.
const REWIND_BOUNDARY_FIELD: &str = "lastTurnId";

/// The refusal phrases that name a field rather than a method: a missing parameter and an
/// undeclared one. `unknown variant` is left out because it names a method.
const FIELD_LEVEL_REFUSAL_PHRASES: &[&str] = &["missing field", "unknown field"];

/// The error code the service answers a request with when its inbound queue is full: the request
/// never reached it, and the connection stays.
const CODEX_OVERLOADED_CODE: i64 = -32001;

/// JSON-RPC's invalid-request code, which the service's draining answer carries.
pub(crate) const CODEX_INVALID_REQUEST_CODE: i64 = -32600;

/// The `data.reason` of the service's answer while it drains toward its exit.
pub(crate) const CODEX_DRAINING_REASON: &str = "serverShuttingDown";

/// The words of Codex's refusal to resume a conversation another runtime still writes.
const CODEX_ACTIVE_WRITER_MESSAGE: &str = "active writer";

/// The words of Codex's refusal of a catalog read that asks for the service to restart first.
const CODEX_RESTART_REQUESTED_MESSAGE: &str = "Restart Codex";

/// The `data.reason` a turn refused while another of the session's turns is in flight carries.
const SESSION_TURN_IN_FLIGHT_REASON: &str = "sessionTurnInFlight";

/// Which state holds a session's slot when a create is refused; a create is refused in all three,
/// since a second start would orphan a process.
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
    /// A request was written and no answer came: its deadline passed or the connection closed
    /// first, so the service may still act on it.
    #[error("The Codex service did not answer \"{method}\": {cause}")]
    Unanswered {
        /// The request's method.
        method: String,
        /// Why no answer came.
        cause: CodexUnansweredCause,
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
        /// The `reason` member of the error answer's `data`, when it sent one as text.
        reason: Option<String>,
        /// The error answer's `data`, as the service sent it.
        data: Option<Value>,
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
    /// A turn the daemon would start found another of the session's turns running, starting or
    /// still ending, which the turn would fold into.
    #[error("A turn of Codex session \"{session_id}\" is still in flight, so this turn waits.")]
    SessionTurnInFlight {
        /// The session.
        session_id: SessionId,
    },
    /// A turn's start its run withdrew before the turn went; nothing was sent.
    #[error("The run \"{run_id}\" withdrew its turn before it was sent.")]
    TurnWithdrawn {
        /// The run.
        run_id: RunId,
    },
    /// A session asked for a larger window its model's catalog does not offer at that figure now;
    /// no conversation was started.
    #[error(
        "Codex's catalog does not offer the {requested}-token window for model \"{model}\" now."
    )]
    LargerWindowUnavailable {
        /// The model.
        model: String,
        /// The window asked for, in tokens.
        requested: u64,
        /// The larger window the catalog offers the model now, in tokens, if any.
        offered: Option<u64>,
    },
    /// A port the daemon wired, which the driver reads or hands work to, failed.
    #[error("the {port} port failed")]
    PortFailed {
        /// The port, as its registration names it.
        port: &'static str,
        /// Its failure.
        #[source]
        cause: Box<dyn Error + Send + Sync>,
    },
    /// A step that fails in the daemon's driver shape already, a catalog read among them, passed
    /// on as it failed.
    #[error(transparent)]
    Driver(DriverError),
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

/// Why a written request got no answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CodexUnansweredCause {
    /// Its deadline passed.
    Deadline {
        /// How long the request waited.
        timeout: Duration,
    },
    /// The connection closed before the answer.
    ConnectionClosed {
        /// How the connection closed, in words.
        reason: String,
    },
}

impl std::fmt::Display for CodexUnansweredCause {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Deadline { timeout } => write!(formatter, "no answer came within {timeout:?}"),
            Self::ConnectionClosed { reason } => {
                write!(
                    formatter,
                    "the connection closed before the answer: {reason}"
                )
            }
        }
    }
}

impl CodexError {
    /// Whether this is Codex's refusal to resume a conversation another runtime still writes.
    pub(crate) fn is_active_writer_refusal(&self) -> bool {
        self.is_invalid_request_saying(CODEX_ACTIVE_WRITER_MESSAGE)
    }

    /// Whether this is Codex's refusal of a catalog read that asks for the service to restart
    /// before it answers.
    pub(crate) fn asks_for_restart(&self) -> bool {
        self.is_invalid_request_saying(CODEX_RESTART_REQUESTED_MESSAGE)
    }

    // A `-32600` answer whose message holds `words`.
    fn is_invalid_request_saying(&self, words: &str) -> bool {
        matches!(
            self,
            Self::ProviderRequest { code: CODEX_INVALID_REQUEST_CODE, message, .. }
                if message.contains(words)
        )
    }

    /// Whether this is the service's answer that it is draining toward its exit and takes no new
    /// work, while its running turns, reads and interrupts go on.
    pub(crate) fn is_service_draining(&self) -> bool {
        matches!(
            self,
            Self::ProviderRequest { code: CODEX_INVALID_REQUEST_CODE, reason: Some(reason), .. }
                if reason == CODEX_DRAINING_REASON
        )
    }
}

/// Turns a refused `thread/fork` that names the rewind boundary member into
/// `RewindBoundaryUnsupported`, the service's words bounded as a failure detail; any other error
/// is returned unchanged.
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
    /// A transport failure, an over-large request, and the service's overloaded (`-32001`) and
    /// draining answers refuse `provider.unavailable`; a written request with no answer is
    /// `Unanswered`, `provider.timeout` past its deadline and `provider.unavailable` once the
    /// connection closed; each carries the failure's words bounded as `providerFailureDetail`; a
    /// failure already in the driver's shape is passed on as it is; a
    /// refused fork boundary answers `provider.capability.unsupported` on the rollback flag with
    /// Codex's refusal bounded as `providerFailureDetail`, and a session closed under a wait
    /// `session.alreadyClosed`; the rest are internal failures.
    fn from(error: CodexError) -> Self {
        if let CodexError::Driver(error) = error {
            return error;
        }
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
            CodexError::Unanswered { cause, .. } => {
                let (message, code) = match cause {
                    CodexUnansweredCause::Deadline { .. } => (
                        "The Codex service did not answer in time",
                        RefusalCode::ProviderTimeout,
                    ),
                    CodexUnansweredCause::ConnectionClosed { .. } => (
                        "The Codex service's connection closed before it answered",
                        RefusalCode::ProviderUnavailable,
                    ),
                };
                Self::Unanswered(RequestUnanswered {
                    refusal: provider_failure_refusal(
                        &DESCRIPTOR.provider_id(),
                        message,
                        code,
                        error,
                    ),
                })
            }
            CodexError::ProviderRequest {
                code: CODEX_OVERLOADED_CODE,
                ..
            } => Self::Refused(provider_failure_refusal(
                &DESCRIPTOR.provider_id(),
                "The Codex service is overloaded and did not take the request",
                RefusalCode::ProviderUnavailable,
                error,
            )),
            CodexError::ProviderRequest { .. } if error.is_service_draining() => {
                Self::Refused(provider_failure_refusal(
                    &DESCRIPTOR.provider_id(),
                    "The Codex service is shutting down and takes no new work",
                    RefusalCode::ProviderUnavailable,
                    error,
                ))
            }
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
            CodexError::SessionTurnInFlight { session_id } => {
                let session_id = *session_id;
                Self::Refused(
                    DomainError::new(error.to_string(), RefusalCode::ProviderUnavailable)
                        .with_detail(json!({
                            "sessionId": session_id,
                            "reason": SESSION_TURN_IN_FLIGHT_REASON,
                        }))
                        .with_source(error),
                )
            }
            CodexError::LargerWindowUnavailable {
                model,
                requested,
                offered,
            } => {
                let detail = json!({
                    "model": model,
                    "largerWindow": requested,
                    "offeredLargerWindow": offered,
                });
                Self::Refused(
                    DomainError::new(error.to_string(), RefusalCode::ProviderUnavailable)
                        .with_detail(detail)
                        .with_source(error),
                )
            }
            CodexError::ProviderRequest { .. }
            | CodexError::SessionAlreadyLive { .. }
            | CodexError::TurnWithdrawn { .. }
            | CodexError::PortFailed { .. }
            | CodexError::Driver(_)
            | CodexError::DriverConfig { .. } => Self::Internal(Box::new(error)),
        }
    }
}
