//! The errors a Claude session raises, the refusal each reaches a caller as, the recovery
//! condition a failure leaves the session in, and the record of a failure no caller hears.

use std::error::Error;
use std::io;

use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;

use crate::error_description::describe_error;
use crate::provider::driver::capabilities::DriverCapabilityFlag;
use crate::provider::driver::claude::DESCRIPTOR;
use crate::provider::driver::claude::session::transport::control::ClaudeControlSubtype;
use crate::provider::driver::contract::{DriverError, bound_failure_detail};
use crate::provider::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::provider::driver::error_causes::{
    RequestUnanswered, UNSPECIFIED_PROVIDER_FAILURE_DETAIL, provider_failure_refusal,
};
use crate::provider::driver::registry::provider_capability_refused;

/// The detail an authentication probe records once the provider answered it, naming the evidence
/// and never a credential source the probe did not report.
#[expect(
    dead_code,
    reason = "the Claude Code authentication probe records it on a reached handshake"
)]
pub(crate) const CLAUDE_AUTH_PROBE_REACHED_DETAIL: &str =
    "the provider answered the zero-turn auth probe";

/// Why the driver cannot carry out a session or run operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeSessionUnavailableReason {
    /// The spawned process announced a session id other than the one pinned.
    #[expect(
        dead_code,
        reason = "the Claude driver's session lifecycle refuses with it"
    )]
    SessionIdPinDiverged,
    /// No live session is bound to the session.
    NoLiveSession,
    /// No live session is bound to the run.
    NoLiveRun,
    /// The run's turn is already dispatched and has not settled.
    RunAlreadyDispatched,
    /// Another run's turn is still in flight on the session.
    SessionTurnInFlight,
    /// The run's execution posture differs from the one the session was spawned with.
    ExecutionPostureMismatch,
    /// The run requires schema-constrained output and the session was spawned without a schema.
    OutputSchemaUnbound,
    /// The run's output schema differs from the one the session was spawned with.
    OutputSchemaMismatch,
    /// The request named a provider account that is present but empty.
    #[expect(
        dead_code,
        reason = "the Claude driver's session lifecycle refuses with it"
    )]
    ProviderAccountUnusable,
    /// Two resolvers name different provider accounts for the session.
    ProviderAccountAmbiguous,
    /// The process exited before it answered.
    ProcessExited,
    /// The session holds no execution posture, so a turn the daemon starts has no level to run at.
    ExecutionPostureAbsent,
    /// Claude Code cannot run the session at that permission level.
    PermissionLevelUnavailable,
    /// The installed Claude Code lists no code-review skill for the session.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Claude driver's review command refuses with it"
        )
    )]
    ReviewSkillAbsent,
    /// Claude Code's model id names its window, so a session takes no larger-window figure.
    LargerWindowFigureUnsupported,
}

impl ClaudeSessionUnavailableReason {
    // The words a refusal for this reason reads.
    fn message(self) -> &'static str {
        match self {
            Self::SessionIdPinDiverged => {
                "The spawned Claude process announced a session id other than the pinned one."
            }
            Self::NoLiveSession => "No live Claude session is bound to this session.",
            Self::NoLiveRun => "No live Claude session is bound to this run.",
            Self::RunAlreadyDispatched => {
                "This run's turn is already dispatched and has not settled."
            }
            Self::SessionTurnInFlight => {
                "Another run's turn is still in flight on this Claude session; it has not settled."
            }
            Self::ExecutionPostureMismatch => {
                "The run's execution posture does not match the posture the Claude session was \
                 spawned with."
            }
            Self::OutputSchemaUnbound => {
                "The run requires schema-constrained output but the Claude session was spawned \
                 without a schema."
            }
            Self::OutputSchemaMismatch => {
                "The run's output schema differs from the schema the Claude session was spawned \
                 with."
            }
            Self::ProviderAccountUnusable => {
                "The request named a provider account that is present but empty; an account was \
                 meant to be bound and none was."
            }
            Self::ProviderAccountAmbiguous => {
                "Two resolvers name different provider accounts for this Claude session."
            }
            Self::ProcessExited => "The Claude Code process exited before it answered.",
            Self::ExecutionPostureAbsent => {
                "The Claude session holds no execution posture, so a turn the daemon starts has \
                 no level to run at."
            }
            Self::PermissionLevelUnavailable => {
                "Claude Code cannot run this session at that permission level."
            }
            Self::ReviewSkillAbsent => {
                "The installed Claude Code lists no code-review skill for this session."
            }
            Self::LargerWindowFigureUnsupported => {
                "Claude Code's model id names its window, so a Claude session takes no \
                 larger-window figure."
            }
        }
    }
}

/// Which state holds a session's slot when a create or resume is refused; each refuses, since a
/// second process would orphan the first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeSessionSlotState {
    /// A create or resume is in flight.
    Establishing,
    /// A live session holds the slot.
    Live,
    /// The session is still being torn down.
    Closing,
}

/// Why a control request got no answer once anything of it was written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeUnansweredCause {
    /// Its deadline passed.
    Deadline,
    /// The process exited.
    ProcessExited,
    /// Its write failed after some bytes, so the process may have read it whole.
    WriteCut,
}

/// A failure of a Claude session, keeping its cause; `DriverError::from` turns each into the
/// refusal a client reads or an internal failure.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ClaudeSessionError {
    /// The driver cannot carry out the operation now.
    #[error("{}{}", .reason.message(), .detail.as_ref().map(|detail| format!(" {detail}")).unwrap_or_default())]
    Unavailable {
        /// Why.
        reason: ClaudeSessionUnavailableReason,
        /// More words, where the failure has them.
        detail: Option<String>,
        /// The session, where the operation names one.
        session_id: Option<SessionId>,
        /// The run, where the operation names one.
        run_id: Option<RunId>,
    },
    /// Nothing of a write reached the process: its input refused the first byte.
    #[error("nothing could be written to the Claude Code process")]
    InputUnwritable(#[source] io::Error),
    /// The account's sign-in is gone or refused.
    #[error("{detail}")]
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Claude driver's sign-in probe and stream reader report a refused sign-in"
        )
    )]
    AuthenticationRequired {
        /// What the provider reported, never a credential.
        detail: String,
    },
    /// A control request went out and no answer came, so the process may still act on it.
    #[error("the Claude Code process did not answer the {} request", .subtype.as_str())]
    Unanswered {
        /// The request.
        subtype: ClaudeControlSubtype,
        /// Why no answer came.
        cause: ClaudeUnansweredCause,
    },
    /// Claude Code refused a control request.
    #[error("the Claude CLI refused the {} control request: {provider_error}", .subtype.as_str())]
    ControlRequestRefused {
        /// The request.
        subtype: ClaudeControlSubtype,
        /// Claude Code's words.
        provider_error: String,
    },
    /// A process already holds the session's slot.
    #[error("a Claude session already holds this session's slot ({holder_state:?})")]
    SessionAlreadyLive {
        /// The state the slot is in.
        holder_state: ClaudeSessionSlotState,
    },
}

impl ClaudeSessionError {
    /// The recovery condition the failure leaves the session in: sign in again after a refused
    /// sign-in, recover after anything else.
    pub(crate) fn recovery_condition(&self) -> RecoveryCondition {
        match self {
            Self::AuthenticationRequired { .. } => RecoveryCondition::ReauthRequired,
            Self::Unavailable { .. }
            | Self::InputUnwritable(_)
            | Self::Unanswered { .. }
            | Self::ControlRequestRefused { .. }
            | Self::SessionAlreadyLive { .. } => RecoveryCondition::RecoveryNeeded,
        }
    }
}

impl From<ClaudeSessionError> for DriverError {
    /// An unavailable session and an unwritable input answer `provider.unavailable` and a refused
    /// sign-in `provider.account.notAuthenticated`, each with the failure's words bounded as
    /// `providerFailureDetail`; a request with no answer is `Unanswered`, `provider.timeout` past
    /// its deadline and `provider.unavailable` otherwise; a refused `cancel_async_message`,
    /// `mcp_set_servers` or `rewind_conversation` means the build lacks it, answered
    /// `provider.capability.unsupported` on the steer, tool-server or rollback flag with Claude
    /// Code's words; every other refusal and a held slot are internal failures.
    fn from(error: ClaudeSessionError) -> Self {
        let provider = DESCRIPTOR.provider_id();
        match &error {
            ClaudeSessionError::Unavailable { .. } | ClaudeSessionError::InputUnwritable(_) => {
                Self::Refused(provider_failure_refusal(
                    &provider,
                    "The Claude Code process is unavailable",
                    RefusalCode::ProviderUnavailable,
                    error,
                ))
            }
            ClaudeSessionError::AuthenticationRequired { .. } => {
                Self::Refused(provider_failure_refusal(
                    &provider,
                    "The account's Claude Code sign-in is gone or refused",
                    RefusalCode::ProviderAccountNotAuthenticated,
                    error,
                ))
            }
            ClaudeSessionError::Unanswered { cause, .. } => {
                let (message, code) = match cause {
                    ClaudeUnansweredCause::Deadline => (
                        "The Claude Code process did not answer in time",
                        RefusalCode::ProviderTimeout,
                    ),
                    ClaudeUnansweredCause::ProcessExited | ClaudeUnansweredCause::WriteCut => (
                        "The Claude Code process ended before it answered",
                        RefusalCode::ProviderUnavailable,
                    ),
                };
                Self::Unanswered(RequestUnanswered {
                    refusal: provider_failure_refusal(&provider, message, code, error),
                })
            }
            ClaudeSessionError::ControlRequestRefused {
                subtype,
                provider_error,
            } => match missing_capability(*subtype) {
                Some(flag) => {
                    let detail = bound_failure_detail(
                        provider_error,
                        UNSPECIFIED_PROVIDER_FAILURE_DETAIL.clone(),
                    );
                    Self::Refused(
                        provider_capability_refused(&provider, flag, &detail).with_source(error),
                    )
                }
                None => Self::Internal(Box::new(error)),
            },
            ClaudeSessionError::SessionAlreadyLive { .. } => Self::Internal(Box::new(error)),
        }
    }
}

// The capability a refused request shows the build lacks: a request the daemon composes cannot be
// malformed, so a refusal of one of these means the build does not take it. `set_model`'s refusal
// is the model check's own, never a missing capability.
fn missing_capability(subtype: ClaudeControlSubtype) -> Option<DriverCapabilityFlag> {
    match subtype {
        ClaudeControlSubtype::CancelAsyncMessage => Some(DriverCapabilityFlag::Steer),
        ClaudeControlSubtype::McpSetServers => Some(DriverCapabilityFlag::Mcp),
        ClaudeControlSubtype::RewindConversation => Some(DriverCapabilityFlag::Rollback),
        ClaudeControlSubtype::Initialize
        | ClaudeControlSubtype::Interrupt
        | ClaudeControlSubtype::ApplyFlagSettings
        | ClaudeControlSubtype::SetPermissionMode
        | ClaudeControlSubtype::SetMaxThinkingTokens
        | ClaudeControlSubtype::GetSettings
        | ClaudeControlSubtype::GetContextUsage
        | ClaudeControlSubtype::SetModel
        | ClaudeControlSubtype::GetBinaryVersion
        | ClaudeControlSubtype::McpMessage
        | ClaudeControlSubtype::BackgroundTasks
        | ClaudeControlSubtype::GenerateSessionTitle
        | ClaudeControlSubtype::RenameSession
        | ClaudeControlSubtype::NegativeControl => None,
    }
}

/// Records a failure no caller hears, as `kind`'s diagnostic on `session_id` where one is named:
/// `step` names in plain words what failed, and the reason carries `error` with its causes.
pub(crate) fn record_unheard_claude_failure(
    kind: DriverDiagnosticKind,
    session_id: impl Into<Option<SessionId>>,
    step: &str,
    error: &(dyn Error + 'static),
) {
    emit_driver_diagnostic(&DriverDiagnosticRecord {
        provider: DESCRIPTOR.provider_id(),
        provider_account_id: None,
        kind,
        raw_wire_type: None,
        disposition_reason: format!("{step} failed: {}", describe_error(error)),
        details: session_id
            .into()
            .map(|session_id| ("sessionId".to_owned(), json!(session_id)))
            .into_iter()
            .collect(),
    });
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;

    use super::{
        ClaudeControlSubtype, ClaudeSessionError, ClaudeUnansweredCause, RequestUnanswered,
    };
    use crate::provider::driver::contract::DriverError;

    // The refusal's code a driver error answers with, `None` for a failure that is no refusal.
    fn refusal_code(error: &DriverError) -> Option<RefusalCode> {
        match error {
            DriverError::Refused(refusal)
            | DriverError::Unanswered(RequestUnanswered { refusal }) => Some(refusal.code),
            DriverError::SteerTurnEnded(_)
            | DriverError::CapabilityProbe(_)
            | DriverError::ExecutableUnresolvable(_)
            | DriverError::ModelCatalogUnreadable(_)
            | DriverError::ProviderAxisInvalid(_)
            | DriverError::Internal(_) => None,
        }
    }

    // Killed by mapping a deadline to `provider.unavailable`, an exit or a cut write to
    // `provider.timeout`, an unanswered request to a plain refusal, a refused `set_model` to a
    // missing capability, or a refused rewind to an internal failure.
    #[rstest]
    #[case::deadline(
        ClaudeSessionError::Unanswered {
            subtype: ClaudeControlSubtype::Interrupt,
            cause: ClaudeUnansweredCause::Deadline,
        },
        true,
        Some(RefusalCode::ProviderTimeout)
    )]
    #[case::exit(
        ClaudeSessionError::Unanswered {
            subtype: ClaudeControlSubtype::Interrupt,
            cause: ClaudeUnansweredCause::ProcessExited,
        },
        true,
        Some(RefusalCode::ProviderUnavailable)
    )]
    #[case::cut_write(
        ClaudeSessionError::Unanswered {
            subtype: ClaudeControlSubtype::Initialize,
            cause: ClaudeUnansweredCause::WriteCut,
        },
        true,
        Some(RefusalCode::ProviderUnavailable)
    )]
    #[case::refused_rewind(
        ClaudeSessionError::ControlRequestRefused {
            subtype: ClaudeControlSubtype::RewindConversation,
            provider_error: "Unsupported control request subtype: rewind_conversation".to_owned(),
        },
        false,
        Some(RefusalCode::ProviderCapabilityUnsupported)
    )]
    #[case::refused_model(
        ClaudeSessionError::ControlRequestRefused {
            subtype: ClaudeControlSubtype::SetModel,
            provider_error: "model not offered".to_owned(),
        },
        false,
        None
    )]
    #[case::refused_sign_in(
        ClaudeSessionError::AuthenticationRequired { detail: "signed out".to_owned() },
        false,
        Some(RefusalCode::ProviderAccountNotAuthenticated)
    )]
    fn a_session_failure_reaches_the_caller_as_its_refusal(
        #[case] error: ClaudeSessionError,
        #[case] is_unanswered: bool,
        #[case] code: Option<RefusalCode>,
    ) {
        let driver_error = DriverError::from(error);

        assert_eq!(
            matches!(driver_error, DriverError::Unanswered(_)),
            is_unanswered
        );
        assert_eq!(refusal_code(&driver_error), code);
    }
}
