//! Starting a run: the checks a start passes before anything is written (a trigger's fire under
//! the workflow start rule, the pinned version, the session and the trigger's declared inputs),
//! the folder the run works in, the scope its steps share and the input its trigger step starts
//! on, and the one write of the run's row with its `workflow.run.started`, which holds a run
//! joining a chain at its limit.
mod errors;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use jiff::tz::TimeZone;
use rusqlite::Connection;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::jsonrpc::byte_length::json_utf8_byte_length;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::machine::settings::EnvironmentRow;
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::AnyValue;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::list::UniqueList;
use sidekicks_contracts::wire::record::Record;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowDefinitionId, WorkflowEdge, WorkflowName, WorkflowNode, WorkflowNodeId,
    WorkflowVersionId,
};
use sidekicks_contracts::workflow::definition::item::{WorkflowItem, WorkflowPinnedItem};
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
use sidekicks_policy::authorizer::{Authorizer, PolicyDecision};
use sidekicks_policy::workflow_start::{WorkflowStart, check_workflow_start};
use sidekicks_store::data_folder::workflow_run_folder;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::database::stored_column::{closed_word, optional_text_column, text_column};
use sidekicks_store::events::log_service::EventLogService;
use sidekicks_store::events::session::appender::{
    SessionEventAppender, SessionEventDraft, SessionEventLinkage,
};
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;
use sidekicks_store::machine::registry::MachineRegistry;
use sidekicks_workspace::project::records::session_project_sql;
use sidekicks_workspace::working_folder::{
    SessionWorkingFolder, read_project_environment_rows, read_working_folder,
};
use tokio_util::sync::CancellationToken;

use crate::definitions::kept_values::{WorkflowKeptValue, WorkflowKeptValueStore};
use crate::definitions::stored_document::{parse_stored_pin_data, parse_stored_workflow_body};
use crate::definitions::versions::history::WorkflowVersions;
use crate::engine::event_record::{EngineFault, EngineRecorder};
use crate::engine::ports::{ChainAskAfterReader, RunProviderReader, StepPayloadArtifacts};
use crate::engine::tick::RunScope;
use crate::runs::creation::{
    CHAIN_COUNT_STATEMENT_INDEX, CHAIN_ROOT_CHECK_STATEMENT_INDEX, WorkflowRunCreation,
    workflow_run_creation_statements,
};
use crate::secrets::redaction::RunRedaction;

pub(crate) use self::errors::WorkflowRunStartError;

/// The statements a start prepares on a read connection: the pinned version by its id, the
/// session's working folder, the workflow's level and pins, its project's environment rows and
/// the session's project.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
pub(crate) const WORKFLOW_RUN_START_STATEMENT_CAPACITY: usize = 5;

// The level every run of the workflow runs at, and its pinned test items.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
const DEFINITION_SCOPE_SQL: &str =
    "SELECT permission_level, pin_data_json FROM workflow_definitions WHERE id = ?1";

// The project the session works in, NULL for a chat.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
static SESSION_PROJECT_SQL: LazyLock<String> =
    LazyLock::new(|| format!("SELECT {}", session_project_sql("?1")));

/// How a start reached the engine, which decides whether the workflow start rule judges it here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
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
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
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

/// A run the start wrote: the scope its steps share, which holds the folder it works in, the edges
/// of its pinned version and the input its trigger step starts on.
#[derive(Clone)]
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
pub(crate) struct StartedRun {
    /// What the run's steps share, built once here.
    pub(crate) scope: Arc<RunScope>,
    /// The edges of its pinned version.
    pub(crate) edges: Arc<[WorkflowEdge]>,
    /// The input its trigger step starts on.
    pub(crate) trigger_input: WorkflowPayloadRef,
}

impl fmt::Debug for StartedRun {
    /// The run and the folder it works in; the rest of its scope is left out.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StartedRun")
            .field("workflow_run_id", &self.scope.run_id)
            .field("working_folder", &self.scope.working_folder)
            .field("edges", &self.edges)
            .field("trigger_input", &self.trigger_input)
            .finish_non_exhaustive()
    }
}

/// How a start that passed its checks ended.
#[derive(Clone, Debug)]
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
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

/// What a start's checks read: the workflow, its version's body as the run needs it, and the
/// session's working folder.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
struct CheckedStart {
    definition_id: WorkflowDefinitionId,
    workflow_name: WorkflowName,
    trigger_node: WorkflowRunTrigger,
    nodes: HashMap<WorkflowNodeId, WorkflowNode>,
    edges: Arc<[WorkflowEdge]>,
    start_items: Vec<WorkflowItem>,
    session: SessionWorkingFolder,
}

/// What a run's scope reads beside its version: the workflow's level and, for a manual run, its
/// pins, the session's project and that project's environment rows, the workflow's kept values
/// and the provider.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
struct ScopeReads {
    permission_level: PermissionLevel,
    pin_data: Option<Record<String, Vec<WorkflowPinnedItem>>>,
    environment_rows: Vec<EnvironmentRow>,
    project: Option<ProjectId>,
    kept_values: Vec<WorkflowKeptValue>,
    provider: ProviderId,
}

/// The folder a run works in: the session's, or its own, which the start made and removes when it
/// ends without a run.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
enum RunFolder {
    Session(PathBuf),
    Own(PathBuf),
}

impl RunFolder {
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the engine's run start handlers")
    )]
    fn path(&self) -> &Path {
        match self {
            Self::Session(path) | Self::Own(path) => path,
        }
    }
}

/// What a start prepared once its checks passed: the run's id, its start and its folder.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
struct PreparedStart {
    workflow_run_id: WorkflowRunId,
    started_at: WireInstant,
    folder: RunFolder,
}

/// What a [`WorkflowRunStarter`] reads, writes and asks through.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
pub(crate) struct WorkflowRunStarterDependencies {
    /// The read pool every read of a start goes through.
    pub(crate) pool: Arc<DatabaseReadPool>,
    /// The event log each start's write is appended to.
    pub(crate) event_log: Arc<EventLogService>,
    /// The machine's registry, whose owner a trigger's fire is judged as.
    pub(crate) machines: Arc<MachineRegistry>,
    /// The rules a trigger's fire is judged under.
    pub(crate) authorizer: Arc<Authorizer>,
    /// The store of a trigger input above the inline cap.
    pub(crate) payloads: Arc<dyn StepPayloadArtifacts>,
    /// The limit a joining run is counted under.
    pub(crate) chain_ask_after: Arc<dyn ChainAskAfterReader>,
    /// The provider a run's command steps run under.
    pub(crate) provider: Arc<dyn RunProviderReader>,
    /// The values each workflow keeps, which its runs read.
    pub(crate) kept_values: Arc<WorkflowKeptValueStore>,
    /// The data folder a run's own folder is made in.
    pub(crate) data_folder: PathBuf,
    /// The engine's record, which takes what a held start could not clean up.
    pub(crate) recorder: Arc<EngineRecorder>,
}

/// Starts workflow runs: checks each start, prepares the run's folder, reads the scope its steps
/// share, builds its trigger input, and writes the run's row with its started event in one write.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
pub(crate) struct WorkflowRunStarter {
    pool: Arc<DatabaseReadPool>,
    appender: SessionEventAppender,
    machines: Arc<MachineRegistry>,
    authorizer: Arc<Authorizer>,
    payloads: Arc<dyn StepPayloadArtifacts>,
    chain_ask_after: Arc<dyn ChainAskAfterReader>,
    provider: Arc<dyn RunProviderReader>,
    kept_values: Arc<WorkflowKeptValueStore>,
    data_folder: PathBuf,
    recorder: Arc<EngineRecorder>,
}

impl WorkflowRunStarter {
    /// The starter over `dependencies`.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the engine's run start handlers")
    )]
    pub(crate) fn new(dependencies: WorkflowRunStarterDependencies) -> Self {
        let WorkflowRunStarterDependencies {
            pool,
            event_log,
            machines,
            authorizer,
            payloads,
            chain_ask_after,
            provider,
            kept_values,
            data_folder,
            recorder,
        } = dependencies;
        Self {
            pool,
            appender: SessionEventAppender::new(event_log, SESSION_EVENT_VERSION.clone()),
            machines,
            authorizer,
            payloads,
            chain_ask_after,
            provider,
            kept_values,
            data_folder,
            recorder,
        }
    }

    /// Starts `start`'s run: checks it, prepares its folder, reads the scope its steps share,
    /// builds its trigger input, then writes its row and its `workflow.run.started` together, the
    /// event's instant the row's start and the scope's. A run joining a chain at its limit is
    /// held, with nothing written. Fails with
    /// [`WorkflowRunStartError::Refused`] (`workflow.run.startDenied`,
    /// `workflow.run.inputRequired`), [`WorkflowRunStartError::Version`]
    /// (`workflow.version.notFound`) or [`WorkflowRunStartError::Session`] (`session.notFound`)
    /// before anything is made, and with the other variants when a read, the provider, the folder,
    /// the payload store or the write fails; the run's own folder, with its workflow's runs folder
    /// once that is empty, and its stored trigger input go with every outcome but a start. A held start whose folder or stored input cannot be removed
    /// is still answered held, the removal's failure going to the engine's record.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the engine's run start handlers")
    )]
    pub(crate) async fn start(
        &self,
        start: WorkflowRunStart,
    ) -> Result<WorkflowStartOutcome, WorkflowRunStartError> {
        let checked = self.check(&start).await?;
        let prepared = self.prepare(&checked).await?;
        let mut stored_input = None;
        let mut ended = self
            .write(start, checked, &prepared, &mut stored_input)
            .await;
        if matches!(ended, Ok(WorkflowStartOutcome::Started(_))) {
            return ended;
        }
        let run_id = prepared.workflow_run_id;
        if let Some(artifact_id) = stored_input
            && let Err(removal) = self.payloads.delete(&artifact_id).await
        {
            ended = match ended {
                Ok(held) => {
                    self.record_left_behind(run_id, &*removal).await;
                    Ok(held)
                }
                Err(error) => Err(WorkflowRunStartError::PayloadLeft {
                    artifact_id,
                    ended: Box::new(error),
                    removal,
                }),
            };
        }
        if let RunFolder::Own(folder) = prepared.folder
            && let Err((folder, removal)) = remove_own_folder(folder).await
        {
            ended = match ended {
                Ok(held) => {
                    self.record_left_behind(run_id, &removal).await;
                    Ok(held)
                }
                Err(error) => Err(WorkflowRunStartError::FolderLeft {
                    folder,
                    ended: Box::new(error),
                    removal,
                }),
            };
        }
        ended
    }

    // Records what a held start could not remove, under the run id it minted.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the engine's run start handlers")
    )]
    async fn record_left_behind(
        &self,
        run_id: WorkflowRunId,
        removal: &(dyn std::error::Error + Send + Sync + 'static),
    ) {
        self.recorder
            .for_run(run_id, Arc::new(RunRedaction::new(&[])))
            .fault(None, EngineFault::HeldStartLeftBehind, removal)
            .await;
    }

    // The checks, in order, before anything is made: a trigger's fire under the workflow start
    // rule, the version, the session, the trigger's declared inputs.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the engine's run start handlers")
    )]
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
        // The run's nodes are its trigger's and its version's.
        let nodes = std::iter::once(WorkflowNode::from(&body.trigger))
            .chain(body.nodes)
            .map(|node| (node.id.clone(), node))
            .collect();
        Ok(CheckedStart {
            definition_id: version.definition_id,
            workflow_name: body.name,
            trigger_node: WorkflowRunTrigger {
                kind: start.trigger_kind,
                node_id: body.trigger.id,
            },
            nodes,
            edges: Arc::from(body.edges),
            start_items,
            session,
        })
    }

    // Mints the run's id and its start, and makes its own folder where the session has none.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the engine's run start handlers")
    )]
    async fn prepare(
        &self,
        checked: &CheckedStart,
    ) -> Result<PreparedStart, WorkflowRunStartError> {
        let workflow_run_id =
            WorkflowRunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        let started_at = WireInstant::now();
        let folder = if let Some(folder) = &checked.session.working_folder {
            RunFolder::Session(folder.clone())
        } else {
            let folder =
                workflow_run_folder(&self.data_folder, &checked.definition_id, &workflow_run_id);
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

    // What the run's scope reads beside its version: one pooled read of the workflow's level and
    // pins, the project's environment rows and the session's project, then the workflow's kept
    // values and the provider. Pins are taken for a manual run only.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the engine's run start handlers")
    )]
    async fn read_scope(
        &self,
        session_id: SessionId,
        mode: WorkflowRunMode,
        checked: &CheckedStart,
    ) -> Result<ScopeReads, WorkflowRunStartError> {
        let definition_id = checked.definition_id;
        let session = checked.session.clone();
        let is_manual = mode == WorkflowRunMode::Manual;
        let (permission_level, pin_data, environment_rows, project) = self
            .pool
            .read(ReadLength::Short, move |connection| {
                let (permission_level, pin_data_json) =
                    read_definition_scope(connection, definition_id)?;
                let pin_data = pin_data_json
                    .filter(|_| is_manual)
                    .as_deref()
                    .map(parse_stored_pin_data)
                    .transpose()?;
                let environment_rows = read_project_environment_rows(connection, &session)?;
                let project = read_session_project(connection, &session_id)?;
                Ok::<_, WorkflowRunStartError>((
                    permission_level,
                    pin_data,
                    environment_rows,
                    project,
                ))
            })
            .await?;
        let kept_values = self.kept_values.read(definition_id).await?;
        let provider = self
            .provider
            .run_provider(&definition_id, &session_id)
            .await
            .map_err(WorkflowRunStartError::Provider)?;
        Ok(ScopeReads {
            permission_level,
            pin_data,
            environment_rows,
            project,
            kept_values,
            provider,
        })
    }

    // The trigger step's input: inline within the cap, else stored through the payload store
    // under the trigger step's key.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the engine's run start handlers")
    )]
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
        let size_bytes = SafeInt::new(SafeInt::from_usize(bytes.len()).get())
            .expect("a payload above the inline cap holds bytes");
        let item_count = SafeInt::from_usize(items.len());
        let artifact_id = self
            .payloads
            .write(session_id, trigger_step, bytes, item_count.get())
            .await
            .map_err(WorkflowRunStartError::Payload)?;
        Ok(WorkflowPayloadRef::Artifact {
            artifact_id,
            size_bytes,
            item_count,
        })
    }

    // Reads the run's scope and builds the trigger step's input, then commits the run's row, with
    // its chain's count for a joining run, and its started event, whose instant is the row's start.
    // The scope is read first, so a failed read leaves no stored input behind; an input it stores
    // is named in `stored_input`, for the start to delete when no run is made.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the engine's run start handlers")
    )]
    async fn write(
        &self,
        start: WorkflowRunStart,
        checked: CheckedStart,
        prepared: &PreparedStart,
        stored_input: &mut Option<ArtifactId>,
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
        let scope_reads = self.read_scope(session_id, mode, &checked).await?;
        let trigger_step = WorkflowStepKey {
            workflow_run_id,
            node_id: checked.trigger_node.node_id.clone(),
            attempt: SafeInt::new(1).expect("one is a first attempt"),
            execution_index: SafeInt::ZERO,
        };
        let trigger_input = self
            .trigger_input(session_id, &trigger_step, &checked.start_items)
            .await?;
        if let WorkflowPayloadRef::Artifact { artifact_id, .. } = &trigger_input {
            *stored_input = Some(*artifact_id);
        }
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
                trigger: checked.trigger_node.clone(),
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
            (Ok(_receipt), _) => {
                let node_params = checked
                    .nodes
                    .iter()
                    .map(|(node_id, node)| (node_id.clone(), node.params.clone()))
                    .collect();
                let scope = RunScope {
                    session_id,
                    run_id: workflow_run_id,
                    workflow_id: checked.definition_id,
                    workflow_name: checked.workflow_name,
                    mode,
                    trigger: checked.trigger_node,
                    nodes: checked.nodes,
                    node_params: Arc::new(node_params),
                    pin_data: scope_reads.pin_data,
                    run_started_at: prepared
                        .started_at
                        .timestamp()
                        .expect("a minted instant reads as a timestamp"),
                    time_zone: TimeZone::system(),
                    environment_rows: Arc::from(scope_reads.environment_rows),
                    kept_values: Arc::from(scope_reads.kept_values),
                    project: scope_reads.project,
                    working_folder: prepared.folder.path().to_path_buf(),
                    permission_level: scope_reads.permission_level,
                    provider: scope_reads.provider,
                    redaction: Arc::new(RunRedaction::new(&[])),
                    cancel: CancellationToken::new(),
                };
                Ok(WorkflowStartOutcome::Started(StartedRun {
                    scope: Arc::new(scope),
                    edges: checked.edges,
                    trigger_input,
                }))
            }
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

// The workflow's level and its stored pins.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
fn read_definition_scope(
    connection: &Connection,
    definition_id: WorkflowDefinitionId,
) -> rusqlite::Result<(PermissionLevel, Option<String>)> {
    connection
        .prepare_cached(DEFINITION_SCOPE_SQL)?
        .query_row([definition_id.text().as_str()], |row| {
            Ok((text_column(row, 0, closed_word)?, row.get(1)?))
        })
}

// The project `session_id` works in; `None` for a chat or a session not bound to a project yet.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
fn read_session_project(
    connection: &Connection,
    session_id: &SessionId,
) -> rusqlite::Result<Option<ProjectId>> {
    connection
        .prepare_cached(SESSION_PROJECT_SQL.as_str())?
        .query_row([session_id.text().as_str()], |row| {
            optional_text_column(row, 0, |text| ProjectId::new(&text))
        })
}

/// The refusal of a start the workflow start rule denied, with the rule's errors when it gave
/// any.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
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
// there yet, so a removal never takes a folder another start made. A run's delete removes the
// workflow's runs folder once it empties, so a parent gone between the two steps is made again;
// that single retry is the bound, and a parent gone a second time fails the start.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
async fn make_own_folder(folder: &Path) -> io::Result<()> {
    let parent = folder
        .parent()
        .expect("a run's folder sits in its workflow's runs folder");
    tokio::fs::create_dir_all(parent).await?;
    match tokio::fs::create_dir(folder).await {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            tokio::fs::create_dir_all(parent).await?;
            tokio::fs::create_dir(folder).await
        }
        made => made,
    }
}

// Removes a run's own `folder`, then its workflow's runs folder when that leaves it empty, so no
// empty folder stays for a workflow whose start made no run. Fails with the folder left and why.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
async fn remove_own_folder(folder: PathBuf) -> Result<(), (PathBuf, io::Error)> {
    if let Err(removal) = tokio::fs::remove_dir_all(&folder).await {
        return Err((folder, removal));
    }
    let runs_folder = folder
        .parent()
        .expect("a run's folder sits in its workflow's runs folder")
        .to_path_buf();
    match tokio::fs::remove_dir(&runs_folder).await {
        Ok(()) => Ok(()),
        // Another run of the workflow still has its folder there, or a run's delete took it.
        Err(removal)
            if matches!(
                removal.kind(),
                io::ErrorKind::DirectoryNotEmpty | io::ErrorKind::NotFound
            ) =>
        {
            Ok(())
        }
        Err(removal) => Err((runs_folder, removal)),
    }
}
