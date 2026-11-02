//! Starting a run: the checks a start passes before anything is written (a trigger's fire under
//! the workflow start rule, the pinned version, the session and the trigger's declared inputs),
//! the folder the run works in and the input its trigger step starts on, and the one write of the
//! run's row with its `workflow.run.started`, which holds a run joining a chain at its limit.
#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the program's workflow engine and its start handlers, which start runs"
    )
)]

#[cfg(test)]
mod tests;

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::jsonrpc::byte_length::json_utf8_byte_length;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::AnyValue;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::list::UniqueList;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowDefinitionId, WorkflowEdge, WorkflowVersionId,
};
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::control::fill_workflow_trigger_inputs;
use sidekicks_contracts::workflow::run::events::WorkflowRunStartedPayload;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::step::record::{
    WORKFLOW_STEP_PAYLOAD_INLINE_BYTE_CAP, WorkflowPayloadRef, WorkflowStepKey,
};
use sidekicks_contracts::workflow::run::trigger::{
    WorkflowRunChainPlace, WorkflowRunMode, WorkflowRunTrigger, WorkflowStartedBy,
    WorkflowTriggerKind,
};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_policy::authorizer::{Authorizer, PolicyDecision};
use sidekicks_policy::workflow_start::{WorkflowStart, check_workflow_start};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::events::log_service::EventLogService;
use sidekicks_store::events::session::appender::{
    SessionEventAppendError, SessionEventAppender, SessionEventDraft, SessionEventDraftError,
    SessionEventLinkage,
};
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;
use sidekicks_store::machine::registry::{MachineRegistry, MachineRegistryReadError};
use sidekicks_workspace::working_folder::{WorkingFolderReadError, read_working_folder};

use crate::definitions::stored_document::{StoredDocumentError, parse_stored_workflow_body};
use crate::definitions::versions::history::{WorkflowVersions, WorkflowVersionsError};
use crate::engine::ports::{ChainAskAfterReader, PortError, StepPayloadArtifacts};
use crate::runs::creation::{
    CHAIN_COUNT_STATEMENT_INDEX, CHAIN_ROOT_CHECK_STATEMENT_INDEX, WorkflowRunCreation,
    workflow_run_creation_statements,
};

/// The statements a start prepares on a read connection: the pinned version by its id and the
/// session's working folder.
pub(crate) const WORKFLOW_RUN_START_STATEMENT_CAPACITY: usize = 2;

// The folder in the data folder that holds each workflow's runs' own folders.
const WORKFLOWS_FOLDER_NAME: &str = "workflows";

// The folder in a workflow's folder that holds its runs' own folders.
const RUNS_FOLDER_NAME: &str = "runs";

/// How a start reached the engine, which decides whether the workflow start rule judges it here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WorkflowStartArrival {
    /// The person's own start, from any of their devices, which no rule judges.
    Person,
    /// An agent's start, which the rule judged when its tool asked.
    Agent,
    /// A trigger's fire, which the rule judges here, when it fires.
    Trigger,
}

/// One start: the version it pins, the session it lives in, how and by whom it was started, its
/// place in its chain and the items it was given.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct WorkflowRunStart {
    /// The version the run pins.
    pub(crate) workflow_version_id: WorkflowVersionId,
    /// The session the run lives in.
    pub(crate) session_id: SessionId,
    /// How it was started.
    pub(crate) mode: WorkflowRunMode,
    /// The kind of trigger it is recorded under.
    pub(crate) trigger_kind: WorkflowTriggerKind,
    /// How the start reached the engine.
    pub(crate) arrival: WorkflowStartArrival,
    /// Who or what started it.
    pub(crate) started_by: WorkflowStartedBy,
    /// Its place in its chain.
    pub(crate) chain: WorkflowRunChainPlace,
    /// The items it was given, whose first item's `json` fills the trigger's declared inputs.
    pub(crate) input: Vec<WorkflowItem>,
}

/// A run the start wrote: the folder it works in, the edges of its pinned version and the input
/// its trigger step starts on.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct StartedRun {
    /// The run.
    pub(crate) workflow_run_id: WorkflowRunId,
    /// The session's working folder, or the run's own folder the start made.
    pub(crate) working_folder: PathBuf,
    /// The edges of its pinned version.
    pub(crate) edges: Arc<[WorkflowEdge]>,
    /// The input its trigger step starts on.
    pub(crate) trigger_input: WorkflowPayloadRef,
}

/// How a start that passed its checks ended.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum WorkflowStartOutcome {
    /// The run and its started event were written.
    Started(StartedRun),
    /// The run joins a chain that has reached its ask-after limit with no Keep going answer, so
    /// nothing was written; the chain's question decides whether it starts.
    HeldOnChain {
        /// The chain's first run.
        chain_root_run_id: WorkflowRunId,
    },
}

/// Why a start did not end in an outcome; nothing of the run was written.
#[derive(Debug, thiserror::Error)]
pub(crate) enum WorkflowRunStartError {
    /// The start was refused: `workflow.run.startDenied` or `workflow.run.inputRequired`.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// The version did not read; `workflow.version.notFound` when no saved version has its id.
    #[error(transparent)]
    Version(#[from] WorkflowVersionsError),
    /// The session's working folder did not read; `session.notFound` for a session this daemon
    /// holds no row for.
    #[error(transparent)]
    Session(#[from] WorkingFolderReadError),
    /// The version's stored body does not read as a workflow body.
    #[error("the pinned workflow version does not read")]
    StoredDocument(#[from] StoredDocumentError),
    /// This machine's owner, whom a trigger's fire is judged as, did not read.
    #[error(transparent)]
    Owner(#[from] MachineRegistryReadError),
    /// The read pool is closed, a connection did not open, or the read's task did not finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// The run's own folder could not be made.
    #[error("the run's own folder could not be made")]
    Folder(#[source] io::Error),
    /// The trigger step's input does not write as JSON.
    #[error("the trigger step's input does not write as JSON")]
    InputJson(#[source] serde_json::Error),
    /// The payload store did not keep the trigger step's input.
    #[error("the trigger step's input could not be stored")]
    Payload(#[source] PortError),
    /// The started event broke one of its type's checks.
    #[error("the run's started event could not be drafted")]
    Draft(#[from] SessionEventDraftError),
    /// The event log did not keep the start's write.
    #[error("the run's start was not kept")]
    Append(#[source] SessionEventAppendError),
    /// The chain the run joins has no stored first run at `chain_root_run_id`.
    #[error("the chain the run joins has no stored first run {chain_root_run_id}")]
    ChainRootMissing {
        /// The first run the start named.
        chain_root_run_id: WorkflowRunId,
    },
    /// The start ended without a run and the run's own folder it made could not be removed;
    /// `ended` is how it ended.
    #[error("the run's own folder at {} was left behind", .folder.display())]
    FolderLeft {
        /// The folder.
        folder: PathBuf,
        /// How the start ended.
        ended: Box<Result<WorkflowStartOutcome, WorkflowRunStartError>>,
        /// Why the removal failed.
        #[source]
        removal: io::Error,
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
            fault @ (WorkflowRunStartError::Session(WorkingFolderReadError::Database(_))
            | WorkflowRunStartError::StoredDocument(_)
            | WorkflowRunStartError::Owner(_)
            | WorkflowRunStartError::Pool(_)
            | WorkflowRunStartError::Folder(_)
            | WorkflowRunStartError::InputJson(_)
            | WorkflowRunStartError::Payload(_)
            | WorkflowRunStartError::Draft(_)
            | WorkflowRunStartError::Append(_)
            | WorkflowRunStartError::ChainRootMissing { .. }
            | WorkflowRunStartError::FolderLeft { .. }) => Self::Internal(Box::new(fault)),
        }
    }
}

/// What a start's checks read: the workflow, its version's body as the run needs it, and the
/// session's working folder.
struct CheckedStart {
    definition_id: WorkflowDefinitionId,
    trigger_node: WorkflowRunTrigger,
    edges: Arc<[WorkflowEdge]>,
    start_items: Vec<WorkflowItem>,
    session_folder: Option<PathBuf>,
}

/// The folder a run works in: the session's, or its own, which the start made and removes when it
/// ends without a run.
enum RunFolder {
    Session(PathBuf),
    Own(PathBuf),
}

impl RunFolder {
    fn path(&self) -> &Path {
        match self {
            Self::Session(path) | Self::Own(path) => path,
        }
    }
}

/// What a start prepared once its checks passed: the run's id, its start and its folder.
struct PreparedStart {
    workflow_run_id: WorkflowRunId,
    started_at: WireInstant,
    folder: RunFolder,
}

/// Starts workflow runs: checks each start, prepares the run's folder and its trigger input, and
/// writes the run's row with its started event in one write.
pub(crate) struct WorkflowRunStarter {
    pool: Arc<DatabaseReadPool>,
    appender: SessionEventAppender,
    machines: Arc<MachineRegistry>,
    authorizer: Arc<Authorizer>,
    payloads: Arc<dyn StepPayloadArtifacts>,
    chain_ask_after: Arc<dyn ChainAskAfterReader>,
    data_folder: PathBuf,
}

impl WorkflowRunStarter {
    /// The starter reading through `pool`, appending each start to `event_log`, judging a
    /// trigger's fire as `machines`' owner under `authorizer`, storing a large trigger input in
    /// `payloads`, counting a joining run under `chain_ask_after`'s limit, and making a run's own
    /// folder in `data_folder`.
    pub(crate) fn new(
        pool: Arc<DatabaseReadPool>,
        event_log: Arc<EventLogService>,
        machines: Arc<MachineRegistry>,
        authorizer: Arc<Authorizer>,
        payloads: Arc<dyn StepPayloadArtifacts>,
        chain_ask_after: Arc<dyn ChainAskAfterReader>,
        data_folder: PathBuf,
    ) -> Self {
        Self {
            pool,
            appender: SessionEventAppender::new(event_log, SESSION_EVENT_VERSION.clone()),
            machines,
            authorizer,
            payloads,
            chain_ask_after,
            data_folder,
        }
    }

    /// Starts `start`'s run: checks it, prepares its folder, builds its trigger input, then writes
    /// its row and its `workflow.run.started` together, the event's instant the row's start. A run
    /// joining a chain at its limit is held, with nothing written. Fails with
    /// [`WorkflowRunStartError::Refused`] (`workflow.run.startDenied`,
    /// `workflow.run.inputRequired`), [`WorkflowRunStartError::Version`]
    /// (`workflow.version.notFound`) or [`WorkflowRunStartError::Session`] (`session.notFound`)
    /// before anything is made, and with the other variants when a read, the folder, the payload
    /// store or the write fails; the run's own folder goes with every outcome but a start.
    pub(crate) async fn start(
        &self,
        start: WorkflowRunStart,
    ) -> Result<WorkflowStartOutcome, WorkflowRunStartError> {
        let checked = self.check(&start).await?;
        let prepared = self.prepare(&checked).await?;
        let ended = self.write(start, checked, &prepared).await;
        let is_started = matches!(ended, Ok(WorkflowStartOutcome::Started(_)));
        match prepared.folder {
            RunFolder::Own(folder) if !is_started => remove_own_folder(folder, ended).await,
            RunFolder::Own(_) | RunFolder::Session(_) => ended,
        }
    }

    // The checks, in order, before anything is made: a trigger's fire under the workflow start
    // rule, the version, the session, the trigger's declared inputs.
    async fn check(&self, start: &WorkflowRunStart) -> Result<CheckedStart, WorkflowRunStartError> {
        // Only a trigger's fire is judged here, as this machine's owner.
        let judged_owner = match start.arrival {
            WorkflowStartArrival::Trigger => Some(self.machines.read_owner().await?),
            WorkflowStartArrival::Person | WorkflowStartArrival::Agent => None,
        };
        let workflow_version_id = start.workflow_version_id;
        let session_id = start.session_id;
        let (version, session) = self
            .pool
            .read(ReadLength::Short, move |connection| {
                Ok::<_, WorkflowRunStartError>((
                    WorkflowVersions::new(connection).read_version(workflow_version_id),
                    read_working_folder(connection, &session_id),
                ))
            })
            .await?;
        let version = version?;
        if let Some(owner) = judged_owner {
            let decision = check_workflow_start(
                &self.authorizer,
                WorkflowStart {
                    owner: owner.as_ref(),
                    workflow_id: &version.definition_id,
                    posture: None,
                },
            );
            if let PolicyDecision::Deny { errors } = decision {
                return Err(start_denied(&errors).into());
            }
        }
        let session = session?;
        let body = parse_stored_workflow_body(&version.definition_body)?;
        let declared = body
            .trigger
            .inputs
            .as_ref()
            .map_or(&[][..], UniqueList::as_slice);
        let filled = fill_workflow_trigger_inputs(declared, &start.input).map_err(|details| {
            DomainError::new(
                "The start leaves an input unfilled, or gives one a value that does not fit it.",
                RefusalCode::WorkflowRunInputRequired,
            )
            .with_detail(details)
        })?;
        // A trigger that declares inputs starts on one item of their values; any other on the
        // items it was given.
        let start_items = if declared.is_empty() {
            start.input.clone()
        } else {
            vec![WorkflowItem {
                json: AnyValue(
                    serde_json::to_value(&filled).expect("input values write as a JSON object"),
                ),
                binary: None,
                paired_item: None,
                error: None,
            }]
        };
        Ok(CheckedStart {
            definition_id: version.definition_id,
            trigger_node: WorkflowRunTrigger {
                kind: start.trigger_kind,
                node_id: body.trigger.id,
            },
            edges: Arc::from(body.edges),
            start_items,
            session_folder: session.working_folder,
        })
    }

    // Mints the run's id and its start, and makes its own folder where the session has none.
    async fn prepare(
        &self,
        checked: &CheckedStart,
    ) -> Result<PreparedStart, WorkflowRunStartError> {
        let workflow_run_id =
            WorkflowRunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        let started_at = WireInstant::now();
        let folder = if let Some(folder) = &checked.session_folder {
            RunFolder::Session(folder.clone())
        } else {
            let folder = self
                .data_folder
                .join(WORKFLOWS_FOLDER_NAME)
                .join(checked.definition_id.text().as_str())
                .join(RUNS_FOLDER_NAME)
                .join(workflow_run_id.text().as_str());
            make_own_folder(&folder)
                .await
                .map_err(WorkflowRunStartError::Folder)?;
            RunFolder::Own(folder)
        };
        Ok(PreparedStart {
            workflow_run_id,
            started_at,
            folder,
        })
    }

    // The trigger step's input: inline within the cap, else stored through the payload store
    // under the trigger step's key.
    async fn trigger_input(
        &self,
        session_id: SessionId,
        trigger_step: &WorkflowStepKey,
        items: &[WorkflowItem],
    ) -> Result<WorkflowPayloadRef, WorkflowRunStartError> {
        let measured_bytes =
            json_utf8_byte_length(&items).map_err(WorkflowRunStartError::InputJson)?;
        if measured_bytes <= WORKFLOW_STEP_PAYLOAD_INLINE_BYTE_CAP {
            return Ok(WorkflowPayloadRef::Inline {
                items: items.to_vec(),
            });
        }
        let bytes = serde_json::to_vec(items).map_err(WorkflowRunStartError::InputJson)?;
        let size_bytes =
            SafeInt::new(u64::try_from(bytes.len()).expect("a length fits in 64 bits"))
                .expect("a payload above the inline cap holds bytes");
        let item_count = u64::try_from(items.len()).expect("a count fits in 64 bits");
        let artifact_id = self
            .payloads
            .write(session_id, trigger_step, bytes, item_count)
            .await
            .map_err(WorkflowRunStartError::Payload)?;
        Ok(WorkflowPayloadRef::Artifact {
            artifact_id,
            size_bytes,
            item_count: SafeInt::new(item_count).expect("an item count is a safe integer"),
        })
    }

    // Builds the trigger step's input, then commits the run's row, with its chain's count for a
    // joining run, and its started event, whose instant is the row's start.
    async fn write(
        &self,
        start: WorkflowRunStart,
        checked: CheckedStart,
        prepared: &PreparedStart,
    ) -> Result<WorkflowStartOutcome, WorkflowRunStartError> {
        let WorkflowRunStart {
            workflow_version_id,
            session_id,
            mode,
            started_by,
            chain,
            ..
        } = start;
        let workflow_run_id = prepared.workflow_run_id;
        let trigger_step = WorkflowStepKey {
            workflow_run_id,
            node_id: checked.trigger_node.node_id.clone(),
            attempt: SafeInt::new(1).expect("one is a first attempt"),
            execution_index: SafeInt::ZERO,
        };
        let trigger_input = self
            .trigger_input(session_id, &trigger_step, &checked.start_items)
            .await?;
        // The limit is read at each joining start, so a changed setting holds the next one.
        let chain_ask_after = match chain {
            WorkflowRunChainPlace::Joins { .. } => self.chain_ask_after.chain_ask_after_runs(),
            WorkflowRunChainPlace::Starts {} => None,
        };
        let creation = WorkflowRunCreation {
            workflow_run_id,
            workflow_version_id,
            session_id,
            mode,
            trigger: checked.trigger_node.clone(),
            started_by: started_by.clone(),
            chain: chain.clone(),
            execution_context: None,
            started_at: prepared.started_at.clone(),
        };
        let draft = SessionEventDraft::of_session(
            session_id,
            &SessionEvent::WorkflowRunStarted(WorkflowRunStartedPayload {
                session_id,
                workflow_run_id,
                definition_id: checked.definition_id,
                workflow_version_id,
                mode,
                started_by,
                trigger: checked.trigger_node,
                chain: chain.clone(),
                input_ref: trigger_input.clone(),
            }),
        )?;
        let appended = self
            .appender
            .append(
                draft,
                SessionEventLinkage {
                    occurred_at: Some(prepared.started_at.clone()),
                    transactional_prelude: workflow_run_creation_statements(
                        &creation,
                        chain_ask_after,
                    ),
                    ..SessionEventLinkage::default()
                },
            )
            .await;
        match (appended, chain) {
            (Ok(_receipt), _) => Ok(WorkflowStartOutcome::Started(StartedRun {
                workflow_run_id,
                working_folder: prepared.folder.path().to_path_buf(),
                edges: checked.edges,
                trigger_input,
            })),
            (
                Err(error),
                WorkflowRunChainPlace::Joins {
                    chain_root_run_id, ..
                },
            ) if error.refused_statement_index() == Some(CHAIN_COUNT_STATEMENT_INDEX) => {
                Ok(WorkflowStartOutcome::HeldOnChain { chain_root_run_id })
            }
            (
                Err(error),
                WorkflowRunChainPlace::Joins {
                    chain_root_run_id, ..
                },
            ) if error.refused_statement_index() == Some(CHAIN_ROOT_CHECK_STATEMENT_INDEX) => {
                Err(WorkflowRunStartError::ChainRootMissing { chain_root_run_id })
            }
            (Err(error), _) => Err(WorkflowRunStartError::Append(error)),
        }
    }
}

/// The refusal of a start the workflow start rule denied, with the rule's errors when it gave
/// any.
fn start_denied(errors: &[String]) -> DomainError {
    let refusal = DomainError::new(
        "This workflow may not start: a rule stops it.",
        RefusalCode::WorkflowRunStartDenied,
    );
    if errors.is_empty() {
        refusal
    } else {
        refusal.with_detail(serde_json::json!({ "errors": errors }))
    }
}

// Makes `folder` new and empty: its parents as needed, then the folder itself, which must not be
// there yet, so a removal never takes a folder another start made.
async fn make_own_folder(folder: &Path) -> io::Result<()> {
    if let Some(parent) = folder.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::create_dir(folder).await
}

// Removes the run's own `folder` after a start that ended without a run, and answers how it
// ended; a folder that cannot be removed is a failure that keeps how it ended.
async fn remove_own_folder(
    folder: PathBuf,
    ended: Result<WorkflowStartOutcome, WorkflowRunStartError>,
) -> Result<WorkflowStartOutcome, WorkflowRunStartError> {
    match tokio::fs::remove_dir_all(&folder).await {
        Ok(()) => ended,
        Err(removal) => Err(WorkflowRunStartError::FolderLeft {
            folder,
            ended: Box::new(ended),
            removal,
        }),
    }
}
