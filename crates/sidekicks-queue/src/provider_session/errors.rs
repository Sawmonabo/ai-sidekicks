//! Why a session's provider session was not opened, a run's binding not recorded, or a level or
//! mode not moved, and the refusal or fault each failure answers a caller with.

use std::error::Error;

use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::run::posture::ExecutionPostureRejection;
use sidekicks_provider::runtime_binding::resume::RuntimeBindingNotResumable;
use sidekicks_provider::runtime_binding::store::RuntimeBindingStoreError;
use sidekicks_session::changes::refuse_unchangeable_session;
use sidekicks_session::run::agent::RunAgentReadError;
use sidekicks_session::run::binding_cursors::RunBindingCursorError;
use sidekicks_std::port_registration::PortRegistrationError;
use sidekicks_store::database::connection::read_pool::DatabaseReadError;

use crate::provider_session::controls::NoticeWriteError;

/// Why a session's provider session was not opened, a run's binding not recorded, or a level or
/// mode not moved; nothing of an opening that failed is left live.
#[derive(Debug, thiserror::Error)]
pub enum ProviderSessionError {
    /// The session's opening could not be composed.
    #[error("the provider session of session {session_id} could not be composed")]
    Compose {
        /// The session.
        session_id: SessionId,
        /// Why.
        #[source]
        cause: Box<dyn Error + Send + Sync>,
    },
    /// The account the session's first run was admitted against could not be read.
    #[error(transparent)]
    AdmittedAccount(#[from] RunAgentReadError),
    /// The session's lead runs at no posture.
    #[error("the lead of session {session_id} runs at no posture")]
    NoPosture {
        /// The session.
        session_id: SessionId,
    },
    /// The provider's driver has recorded no capabilities yet, so no contract version.
    #[error("the driver of {} declares no contract version yet", .provider.as_str())]
    NoContractVersion {
        /// The provider.
        provider: ProviderId,
    },
    /// No driver answers the session's provider.
    #[error(transparent)]
    Provider(#[from] DomainError),
    /// The driver failed the create, the resume, the level or mode move, or the end of the turns a
    /// restart kept.
    #[error(transparent)]
    Driver(#[from] DriverError),
    /// The provider refused to resume the session's conversation.
    #[error("the provider could not resume session {session_id} ({recovery_condition:?})")]
    ResumeRefused {
        /// The session.
        session_id: SessionId,
        /// The provider that refused.
        provider: ProviderId,
        /// Why the resume needs recovery.
        recovery_condition: RecoveryCondition,
        /// The provider's own words.
        provider_failure_detail: FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>,
    },
    /// The session's newest binding holds no conversation to resume.
    #[error(transparent)]
    NotResumable(#[from] RuntimeBindingNotResumable),
    /// The session closed, so no process opens for it.
    #[error("session {session_id} is closed")]
    Closed {
        /// The session.
        session_id: SessionId,
    },
    /// The session is being deleted, so no process opens for it.
    #[error("session {session_id} is being deleted")]
    BeingDeleted {
        /// The session.
        session_id: SessionId,
    },
    /// The session has no provider session open in this daemon.
    #[error("session {session_id} has no provider session open")]
    NotOpen {
        /// The session.
        session_id: SessionId,
    },
    /// The session has no conversation to run on.
    #[error("session {session_id} has no conversation to run on")]
    NoConversation {
        /// The session.
        session_id: SessionId,
    },
    /// Calls an undo's settle named are still open in the session's log after its provider
    /// answered, so the turns they were made in are not cut.
    #[error("session {session_id} still holds cut tool calls open after their settle")]
    HeldCallsOpen {
        /// The session.
        session_id: SessionId,
        /// The calls still open.
        tool_call_ids: Vec<ToolCallId>,
    },
    /// The binding or its cursor was not recorded.
    #[error(transparent)]
    Cursor(#[from] RunBindingCursorError),
    /// The runs a resume named were not settled as the provider answered for them, so its binding
    /// was not recorded.
    #[error("the runs the resume of session {session_id} named were not settled")]
    ResumedRuns {
        /// The session.
        session_id: SessionId,
        /// Why.
        #[source]
        cause: Box<dyn Error + Send + Sync>,
    },
    /// The orphaned answers of the session's held lead could not be read, or a continue mark of
    /// one could not be claimed.
    #[error("session {session_id}'s orphaned answers could not be read or claimed")]
    OrphanedAnswers {
        /// The session.
        session_id: SessionId,
        /// Why.
        #[source]
        cause: Box<dyn Error + Send + Sync>,
    },
    /// A relaunch that carried a held lead's continue failed, and a continue mark it claimed could
    /// not be given back, so the next continue misses that answer.
    #[error(
        "the relaunch of session {session_id} failed ({failed}), and a continue mark it claimed \
             could not be given back"
    )]
    ContinueNotReleased {
        /// The session.
        session_id: SessionId,
        /// Why the relaunch failed.
        failed: Box<ProviderSessionError>,
        /// Why the mark was not given back.
        #[source]
        released: Box<dyn Error + Send + Sync>,
    },
    /// A relaunch whose provider carried the held lead's continue failed after, on the daemon's
    /// side; the lead runs on with the person's answers, which stay claimed.
    #[error(
        "the relaunch of session {session_id} failed after its provider carried the held lead's \
             continue"
    )]
    AfterCarriedContinue {
        /// The session.
        session_id: SessionId,
        /// Why the relaunch failed.
        #[source]
        failed: Box<ProviderSessionError>,
    },
    /// A port the provider sessions call is not registered yet.
    #[error(transparent)]
    Port(#[from] PortRegistrationError),
    /// The binding of a process the driver opened was not recorded, and the process could not be
    /// closed.
    #[error(
        "the binding of session {session_id}'s process was not recorded ({recorded}), and the \
             process could not be closed"
    )]
    UnrecordedNotClosed {
        /// The session.
        session_id: SessionId,
        /// Why the binding was not recorded: its record failed, or the runs its resume named were
        /// not settled.
        recorded: Box<ProviderSessionError>,
        /// Why the close failed.
        #[source]
        closed: DriverError,
    },
    /// A start failed because the session's provider is missing, and the notice that says so could
    /// not be posted.
    #[error(
        "the start of session {session_id} failed ({start}), and its provider-missing notice was \
             not posted"
    )]
    ProviderMissingNotPosted {
        /// The session.
        session_id: SessionId,
        /// Why the start failed: no driver answers the provider, or it is not installed.
        start: Box<ProviderSessionError>,
        /// Why the notice was not posted.
        #[source]
        posted: Box<dyn Error + Send + Sync>,
    },
    /// The session's leg could not be read.
    #[error(transparent)]
    Store(#[from] RuntimeBindingStoreError),
    /// The posture of the level the session was to move to did not resolve, or the folder it names
    /// is unavailable, so neither its process nor its record moved.
    #[error("the posture of the level session {session_id} was to move to was refused")]
    PostureRefused {
        /// The session.
        session_id: SessionId,
        /// Why the posture was refused.
        #[source]
        cause: ExecutionPostureRejection,
    },
    /// The git folder the posture of the session's level is built on could not be read.
    #[error("the git folder of session {session_id} could not be read")]
    GitFolder {
        /// The session.
        session_id: SessionId,
        /// Why.
        #[source]
        cause: Box<dyn Error + Send + Sync>,
    },
    /// The level the session moved to was not stored, and a process it runs moved back.
    #[error("the level session {session_id} moved to was not stored")]
    LevelNotStored {
        /// The session.
        session_id: SessionId,
        /// Why the store failed: a refusal for a session gone meanwhile or whose history takes no
        /// write, else a fault.
        #[source]
        cause: NoticeWriteError,
    },
    /// The level was not stored, and the process could not move back to the one stored.
    #[error(
        "the level session {session_id} moved to was not stored ({stored}), and its process \
             could not move back"
    )]
    LevelNotMovedBack {
        /// The session.
        session_id: SessionId,
        /// Why the store failed.
        stored: NoticeWriteError,
        /// Why the move back failed.
        #[source]
        moved_back: DriverError,
    },
    /// The mode the session moved to was not stored, and a process it runs moved back.
    #[error("the mode session {session_id} moved to was not stored")]
    ModeNotStored {
        /// The session.
        session_id: SessionId,
        /// Why the store failed: a refusal for a session gone meanwhile or whose history takes no
        /// write, else a fault.
        #[source]
        cause: NoticeWriteError,
    },
    /// The mode was not stored, and the process could not move back to the one stored.
    #[error(
        "the mode session {session_id} moved to was not stored ({stored}), and its process \
             could not move back"
    )]
    ModeNotMovedBack {
        /// The session.
        session_id: SessionId,
        /// Why the store failed.
        stored: NoticeWriteError,
        /// Why the move back failed.
        #[source]
        moved_back: DriverError,
    },
    /// SQLite refused a read, or a stored value does not read as its type.
    #[error("a read of the session's bindings, mode, level or kept schedules failed")]
    Read(#[from] rusqlite::Error),
    /// The read pool did not run a read.
    #[error("a read of the session's bindings, mode or level did not reach the database")]
    Pool(#[from] DatabaseReadError),
}

impl From<ProviderSessionError> for HandlerError {
    /// No driver for the session's provider answers its refusal, a driver's failure answers as the
    /// driver's own, a closed or purging session answers `session.alreadyClosed` or
    /// `session.changeRefused`, and a level or mode store refused for a session gone meanwhile
    /// answers `session.notFound`, or by its history's own code while that is rebuilt or damaged,
    /// a level whose posture's folder does not resolve answers `workspace.rootUnavailable`;
    /// anything else, a resume refused among them, is a fault.
    fn from(error: ProviderSessionError) -> Self {
        match error {
            ProviderSessionError::Provider(refusal) => Self::Refused(refusal),
            ProviderSessionError::LevelNotStored {
                cause: NoticeWriteError::Refused(refusal),
                ..
            }
            | ProviderSessionError::ModeNotStored {
                cause: NoticeWriteError::Refused(refusal),
                ..
            } => Self::Refused(*refusal),
            ProviderSessionError::Driver(driver) => driver.into(),
            ProviderSessionError::Closed { session_id } => Self::Refused(
                unchangeable_session_refusal(&session_id, SessionState::Closed),
            ),
            ProviderSessionError::BeingDeleted { session_id } => Self::Refused(
                unchangeable_session_refusal(&session_id, SessionState::PurgeRequested),
            ),
            ProviderSessionError::PostureRefused { session_id, cause } => {
                Self::Refused(posture_refusal(&session_id, cause))
            }
            fault @ (ProviderSessionError::Compose { .. }
            | ProviderSessionError::GitFolder { .. }
            | ProviderSessionError::AdmittedAccount(_)
            | ProviderSessionError::NoPosture { .. }
            | ProviderSessionError::NoContractVersion { .. }
            | ProviderSessionError::ResumeRefused { .. }
            | ProviderSessionError::NotResumable(_)
            | ProviderSessionError::NotOpen { .. }
            | ProviderSessionError::HeldCallsOpen { .. }
            | ProviderSessionError::NoConversation { .. }
            | ProviderSessionError::Cursor(_)
            | ProviderSessionError::ResumedRuns { .. }
            | ProviderSessionError::OrphanedAnswers { .. }
            | ProviderSessionError::ContinueNotReleased { .. }
            | ProviderSessionError::AfterCarriedContinue { .. }
            | ProviderSessionError::Port(_)
            | ProviderSessionError::UnrecordedNotClosed { .. }
            | ProviderSessionError::ProviderMissingNotPosted { .. }
            | ProviderSessionError::Store(_)
            | ProviderSessionError::LevelNotStored {
                cause: NoticeWriteError::Emit(_),
                ..
            }
            | ProviderSessionError::LevelNotMovedBack { .. }
            | ProviderSessionError::ModeNotStored {
                cause: NoticeWriteError::Emit(_),
                ..
            }
            | ProviderSessionError::ModeNotMovedBack { .. }
            | ProviderSessionError::Read(_)
            | ProviderSessionError::Pool(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

// The refusal a closed or purging session answers a control with.
fn unchangeable_session_refusal(session_id: &SessionId, state: SessionState) -> DomainError {
    refuse_unchangeable_session(session_id, state)
        .expect_err("a closed or purging session takes no change")
}

// The refusal a level move answers whose posture's folder no longer resolves, keeping the
// rejection as its cause; its message names no path, since a refusal can reach a remote caller.
fn posture_refusal(session_id: &SessionId, cause: ExecutionPostureRejection) -> DomainError {
    DomainError::new(
        "The folder this level lets the session write to is unreachable, so the level did not \
         move.",
        RefusalCode::WorkspaceRootUnavailable,
    )
    .with_detail(json!({ "sessionId": session_id }))
    .with_source(cause)
}
