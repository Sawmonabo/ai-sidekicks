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
use sidekicks_workspace::run_setup_gates::RunSetupGateError;
use sidekicks_workspace::working_folder::{ProjectEnvironmentReadError, WorkingFolderReadError};

use crate::definitions::kept_values::WorkflowKeptValueError;
use crate::definitions::stored_document::StoredDocumentError;
use crate::definitions::versions::history::WorkflowVersionsError;
use crate::engine::partial_run::PartialRunPlanError;
use crate::engine::ports::PortError;
use crate::runs::step_payload::{StepPayloadReadError, StepPayloadWriteError};

/// Why a start did not end in an outcome; nothing of the run was written.
#[derive(Debug, thiserror::Error)]
pub(crate) enum WorkflowRunStartError {
    /// The start was refused: `workflow.run.startDenied`, `workflow.run.projectOnProjectSession`,
    /// `project.notFound`, `workflow.run.inputRequired`, `workflow.run.repositoryRequired`,
    /// `workflow.run.providerRequired`, `workflow.run.nodeKindUnavailable` or
    /// `workflow.run.handleUndeclared`; a retry also `workflow.run.notFound`,
    /// `workflow.run.stillRunning`, `workflow.step.notFound` or `workflow.invalidTransition`; a
    /// node run also `workflow.node.notFound`.
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
    /// The workflow's level, pins or provider, the session's project or the named project's folder
    /// did not read.
    #[error("the run's scope did not read")]
    Scope(#[from] rusqlite::Error),
    /// The environment rows of the session's project did not read, or its project has no row.
    #[error(transparent)]
    ProjectEnvironment(#[from] ProjectEnvironmentReadError),
    /// The values the workflow keeps did not read.
    #[error(transparent)]
    KeptValues(#[from] WorkflowKeptValueError),
    /// A run could not be bound: a project session's to the session's working folder, refused
    /// `workspace.executionRoot.unresolved` wrapping why, a session holding no live workspace and
    /// the write of its context included; a named project's in a workspace of its own, refused as
    /// a workspace bind refuses before that workspace is made and so after; or a failure in the
    /// daemon, such as a session that never held a workspace.
    #[error(transparent)]
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the engine's run start handlers")
    )]
    Binding(RunSetupGateError),
    /// The run's own folder could not be made.
    #[error("the run's own folder could not be made")]
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the engine's run start handlers")
    )]
    Folder(#[source] io::Error),
    /// The run a retry retries, its named node's latest step, its trigger's first input or its
    /// nodes' steps did not read.
    #[error("the run the retry retries did not read")]
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the workflow.run.retry handler")
    )]
    SourceRun(#[source] rusqlite::Error),
    /// A step output, or the trigger input, that a retry or a node run reuses did not read back or
    /// split by its stored counts.
    #[error("an output the run reuses did not read back")]
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the workflow.run.retry and workflow.node.execute handlers"
        )
    )]
    ReusedOutput(#[source] StepPayloadReadError),
    /// A node run's plan did not read.
    #[error(transparent)]
    Plan(#[from] PartialRunPlanError),
    /// An output a node run reuses from another session could not be stored in the run's session.
    #[error("a reused output could not be stored in the run's session")]
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the workflow.node.execute handler")
    )]
    ReusedOutputStore(#[source] StepPayloadWriteError),
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
    /// The start failed and a payload it stored, the trigger step's input or a reused output, could
    /// not be deleted; `ended` is how it failed.
    #[error("the start's stored payload {artifact_id} was left behind")]
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the engine's run start handlers")
    )]
    PayloadLeft {
        /// The stored payload.
        artifact_id: ArtifactId,
        /// How the start failed.
        ended: Box<WorkflowRunStartError>,
        /// Why the deletion failed.
        #[source]
        removal: PortError,
    },
    /// The start failed and the workspace a named project's binding made for its run could not
    /// be deleted; `ended` is how it failed.
    #[error("the workspace made for run {workflow_run_id} was left behind")]
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the engine's run start handlers")
    )]
    WorkspaceLeft {
        /// The run the workspace was made for, which was not started.
        workflow_run_id: WorkflowRunId,
        /// How the start failed.
        ended: Box<WorkflowRunStartError>,
        /// Why the deletion failed.
        #[source]
        removal: RunSetupGateError,
    },
}

impl From<WorkflowRunStartError> for HandlerError {
    /// A start's refusals, a version that is not saved, a session this daemon does not hold and a
    /// binding's refusal answer their refusals; any other failure is a fault in the daemon.
    fn from(error: WorkflowRunStartError) -> Self {
        match error {
            WorkflowRunStartError::Refused(refusal)
            | WorkflowRunStartError::Session(WorkingFolderReadError::Refused(refusal))
            | WorkflowRunStartError::Binding(RunSetupGateError::Refused(refusal)) => {
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
            | WorkflowRunStartError::Binding(RunSetupGateError::Failed(_))
            | WorkflowRunStartError::Folder(_)
            | WorkflowRunStartError::SourceRun(_)
            | WorkflowRunStartError::ReusedOutput(_)
            | WorkflowRunStartError::Plan(_)
            | WorkflowRunStartError::ReusedOutputStore(_)
            | WorkflowRunStartError::InputJson(_)
            | WorkflowRunStartError::Payload(_)
            | WorkflowRunStartError::Draft(_)
            | WorkflowRunStartError::Append(_)
            | WorkflowRunStartError::ChainRootMissing { .. }
            | WorkflowRunStartError::FolderLeft { .. }
            | WorkflowRunStartError::PayloadLeft { .. }
            | WorkflowRunStartError::WorkspaceLeft { .. }) => Self::Internal(Box::new(fault)),
        }
    }
}
