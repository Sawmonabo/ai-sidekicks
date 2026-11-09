//! Why a run's start failed, and how each failure answers the start's caller.

use std::io;
use std::path::PathBuf;

use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_store::database::connection::read_pool::DatabaseReadError;
use sidekicks_store::events::canonicalizer::CanonicalizationRefusal;
use sidekicks_store::events::session::appender::{SessionEventAppendError, SessionEventDraftError};
use sidekicks_store::machine::registry::MachineRegistryReadError;
use sidekicks_workspace::working_folder::{ProjectEnvironmentReadError, WorkingFolderReadError};

use crate::definitions::kept_values::WorkflowKeptValueError;
use crate::definitions::stored_document::StoredDocumentError;
use crate::definitions::versions::history::WorkflowVersionsError;
use crate::engine::ports::PortError;

/// Why a start did not end in an outcome; nothing of the run was written.
#[derive(Debug, thiserror::Error)]
pub(crate) enum WorkflowRunStartError {
    /// The start was refused: `workflow.run.startDenied`, `workflow.run.inputRequired`,
    /// `workflow.run.repositoryRequired`, `workflow.run.providerRequired`,
    /// `workflow.run.nodeKindUnavailable` or `workflow.run.handleUndeclared`.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// The version did not read; `workflow.version.notFound` when no saved version has its id.
    #[error(transparent)]
    Version(#[from] WorkflowVersionsError),
    /// The session's working folder did not read; `session.notFound` for a session this daemon
    /// holds no row for.
    #[error(transparent)]
    Session(#[from] WorkingFolderReadError),
    /// The version's stored body, or the workflow's pinned data, does not read.
    #[error("the pinned workflow version or its pins do not read")]
    StoredDocument(#[from] StoredDocumentError),
    /// The items pinned onto a node cannot be canonicalized for their hash, such as ones nesting
    /// past the ceiling.
    #[error("the items pinned onto a node cannot be hashed")]
    PinHash(#[from] CanonicalizationRefusal),
    /// This machine's owner, whom a trigger's fire is judged as, did not read.
    #[error(transparent)]
    Owner(#[from] MachineRegistryReadError),
    /// The read pool is closed, a connection did not open, or the read's task did not finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// The workflow's level, pins or provider, or the session's project, did not read.
    #[error("the run's scope did not read")]
    Scope(#[from] rusqlite::Error),
    /// The environment rows of the session's project did not read, or its project has no row.
    #[error(transparent)]
    ProjectEnvironment(#[from] ProjectEnvironmentReadError),
    /// The values the workflow keeps did not read.
    #[error(transparent)]
    KeptValues(#[from] WorkflowKeptValueError),
    /// The run's own folder could not be made.
    #[error("the run's own folder could not be made")]
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the engine's run start handlers")
    )]
    Folder(#[source] io::Error),
    /// The trigger step's input does not write as JSON.
    #[error("the trigger step's input does not write as JSON")]
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the engine's run start handlers")
    )]
    InputJson(#[source] serde_json::Error),
    /// The payload store did not keep the trigger step's input.
    #[error("the trigger step's input could not be stored")]
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the engine's run start handlers")
    )]
    Payload(#[source] PortError),
    /// The started event broke one of its type's checks.
    #[error("the run's started event could not be drafted")]
    Draft(#[from] SessionEventDraftError),
    /// The event log did not keep the start's write.
    #[error("the run's start was not kept")]
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the engine's run start handlers")
    )]
    Append(#[source] SessionEventAppendError),
    /// The chain the run joins has no stored first run at `chain_root_run_id`.
    #[error("the chain the run joins has no stored first run {chain_root_run_id}")]
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the engine's run start handlers")
    )]
    ChainRootMissing {
        /// The first run the start named.
        chain_root_run_id: WorkflowRunId,
    },
    /// The start failed and the run's own folder it made could not be removed; `ended` is how it
    /// failed.
    #[error("the run's own folder at {} was left behind", .folder.display())]
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the engine's run start handlers")
    )]
    FolderLeft {
        /// The folder.
        folder: PathBuf,
        /// How the start failed.
        ended: Box<WorkflowRunStartError>,
        /// Why the removal failed.
        #[source]
        removal: io::Error,
    },
    /// The start failed and the trigger step's input it stored could not be deleted; `ended` is how
    /// it failed.
    #[error("the trigger step's stored input {artifact_id} was left behind")]
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the engine's run start handlers")
    )]
    PayloadLeft {
        /// The stored input.
        artifact_id: ArtifactId,
        /// How the start failed.
        ended: Box<WorkflowRunStartError>,
        /// Why the deletion failed.
        #[source]
        removal: PortError,
    },
}

impl From<WorkflowRunStartError> for HandlerError {
    /// A start's refusals, a version that is not saved and a session this daemon does not hold
    /// answer their refusals; any other failure is a fault in the daemon.
    fn from(error: WorkflowRunStartError) -> Self {
        match error {
            WorkflowRunStartError::Refused(refusal)
            | WorkflowRunStartError::Session(WorkingFolderReadError::Refused(refusal)) => {
                Self::Refused(refusal)
            }
            WorkflowRunStartError::Version(error) => error.into(),
            WorkflowRunStartError::KeptValues(error) => error.into(),
            fault @ (WorkflowRunStartError::Session(WorkingFolderReadError::Database(_))
            | WorkflowRunStartError::StoredDocument(_)
            | WorkflowRunStartError::PinHash(_)
            | WorkflowRunStartError::Owner(_)
            | WorkflowRunStartError::Pool(_)
            | WorkflowRunStartError::Scope(_)
            | WorkflowRunStartError::ProjectEnvironment(_)
            | WorkflowRunStartError::Folder(_)
            | WorkflowRunStartError::InputJson(_)
            | WorkflowRunStartError::Payload(_)
            | WorkflowRunStartError::Draft(_)
            | WorkflowRunStartError::Append(_)
            | WorkflowRunStartError::ChainRootMissing { .. }
            | WorkflowRunStartError::FolderLeft { .. }
            | WorkflowRunStartError::PayloadLeft { .. }) => Self::Internal(Box::new(fault)),
        }
    }
}
