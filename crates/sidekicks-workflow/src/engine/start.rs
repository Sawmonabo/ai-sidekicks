//! Starting a run: the checks a start passes before anything is written (a trigger's fire under
//! the workflow start rule, the pinned version, the session, a project named beside a project
//! session, a named project's folder, the trigger's declared inputs, a project's repository for
//! the steps that need one and the workflow's provider for the steps that run in its sandbox), the
//! folder the run works in, a project session's run bound to that session's workspace and a named
//! project's run bound in a workspace of its own, the scope its steps share and the input its
//! trigger step starts on, and the one write of the run's row with its execution context and its
//! `workflow.run.started`, which holds a run joining a chain at its limit.
mod check;
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
use sidekicks_contracts::machine::settings::EnvironmentRow;
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionShape;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::record::Record;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowDefinitionId, WorkflowName, WorkflowNode, WorkflowNodeId, WorkflowVersionId,
};
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::events::WorkflowRunStartedPayload;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::step::record::{WorkflowPayloadRef, WorkflowStepKey};
use sidekicks_contracts::workflow::run::trigger::{
    WorkflowRunChainPlace, WorkflowRunMode, WorkflowRunTrigger, WorkflowStartedBy,
    WorkflowTriggerKind,
};
use sidekicks_policy::authorizer::Authorizer;
use sidekicks_store::data_folder::workflow_run_folder;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::database::stored_column::optional_text_column;
use sidekicks_store::events::canonicalizer::CanonicalizationRefusal;
use sidekicks_store::events::log_service::EventLogService;
use sidekicks_store::events::session::appender::{
    SessionEventAppender, SessionEventDraft, SessionEventLinkage,
};
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;
use sidekicks_store::machine::registry::MachineRegistry;
use sidekicks_workspace::project::records::{AttachedProjectRoot, session_project_sql};
use sidekicks_workspace::run_setup_gates::execution_root::context::{
    RunContextBinding, SessionRunBinder, context_statement, context_write_refusal,
};
use sidekicks_workspace::working_folder::{
    SessionWorkingFolder, read_mount_environment_rows, read_project_environment_rows,
};
use tokio_util::sync::CancellationToken;

use crate::definitions::content_hash::hash_canonical_json;
use crate::definitions::kept_values::{WorkflowKeptValue, WorkflowKeptValueStore};
use crate::definitions::stored_document::parse_stored_pin_data;
use crate::engine::event_record::{EngineFault, EngineRecorder};
use crate::engine::ports::{StepPayloadArtifacts, WorkflowRunLimits};
use crate::engine::tick::{RunGraph, RunPin, RunScope};
use crate::kinds::NodeKindTable;
use crate::runs::creation::{
    CHAIN_COUNT_STATEMENT_INDEX, CHAIN_ROOT_CHECK_STATEMENT_INDEX, WorkflowRunCreation,
    execution_context_statement_index, trigger_step_key, workflow_run_creation_statements,
};
use crate::runs::deletion::remove_run_folder;
use crate::runs::step_payload::{StepPayloadWriteError, write_step_payload};
use crate::secrets::redaction::RunRedaction;

pub(crate) use self::errors::WorkflowRunStartError;

/// The statements a start prepares on a read connection: the pinned version by its id, the
/// session's working folder, the workflow's pins and provider, a named project's folder, its
/// project's environment rows and the session's project.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
pub(crate) const WORKFLOW_RUN_START_STATEMENT_CAPACITY: usize = 6;

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

/// One start: the version it pins, the session it lives in, the project it names, how and by whom
/// it was started, its place in its chain and the items it was given.
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
    /// The project whose repository the start names; `None` where it names none.
    pub(crate) project_id: Option<ProjectId>,
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

/// A run the start wrote: the scope its steps share, which holds the folder it works in, the graph
/// of its pinned version, the input its trigger step starts on, as stored and as items, and the
/// sequence of the write that stored the trigger step's `pending` row.
#[derive(Clone)]
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
pub(crate) struct StartedRun {
    /// What the run's steps share, built once here.
    pub(crate) scope: Arc<RunScope>,
    /// The graph of its pinned version, built once by the start's checks.
    pub(crate) graph: Arc<RunGraph>,
    /// The input its trigger step starts on.
    pub(crate) trigger_input: WorkflowPayloadRef,
    /// The items of that input, kept so the run reads back no artifact the start just wrote.
    pub(crate) trigger_items: Vec<WorkflowItem>,
    /// The sequence of `workflow.run.started`, whose write readied the trigger step.
    pub(crate) started_sequence: SafeInt<0>,
}

impl fmt::Debug for StartedRun {
    /// The run and the folder it works in; the rest of its scope is left out.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StartedRun")
            .field("workflow_run_id", &self.scope.run_id)
            .field("working_folder", &self.scope.working_folder)
            .field("trigger_input", &self.trigger_input)
            .field("started_sequence", &self.started_sequence)
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

/// What a start's checks read: the workflow with its stored pins and provider, its version's body
/// as the run needs it, the session's working folder and the named project's folder.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
struct CheckedStart {
    definition_id: WorkflowDefinitionId,
    workflow_name: WorkflowName,
    trigger_node: WorkflowRunTrigger,
    nodes: HashMap<WorkflowNodeId, WorkflowNode>,
    /// The graph of the pinned version, built once here.
    graph: Arc<RunGraph>,
    start_items: Vec<WorkflowItem>,
    session: SessionWorkingFolder,
    /// The folder of the project the start names, which its run works in; `None` where it names
    /// none.
    project_root: Option<AttachedProjectRoot>,
    pin_data_json: Option<String>,
    provider: Option<ProviderId>,
}

/// What a run's scope reads beside its version and its workflow's row: for a manual run the
/// workflow's pins with their hashes, the session's project and that project's environment rows,
/// and the workflow's kept values.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
struct ScopeReads {
    pins: HashMap<WorkflowNodeId, RunPin>,
    environment_rows: Vec<EnvironmentRow>,
    project: Option<ProjectId>,
    kept_values: Vec<WorkflowKeptValue>,
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

/// What a start prepared once its checks passed: the run's id, its start, its folder and, for a
/// project session's run, its binding in that session's workspace, or for a named project's run,
/// in its own.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
struct PreparedStart {
    workflow_run_id: WorkflowRunId,
    started_at: WireInstant,
    folder: RunFolder,
    binding: Option<RunContextBinding>,
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
    /// The limits a run is held to, a joining run's chain count among them.
    pub(crate) run_limits: Arc<dyn WorkflowRunLimits>,
    /// The values each workflow keeps, which its runs read.
    pub(crate) kept_values: Arc<WorkflowKeptValueStore>,
    /// The kinds a start reads its steps' needs from.
    pub(crate) kinds: Arc<NodeKindTable>,
    /// Binds a project session's run to that session's workspace and a named project's run in a
    /// workspace of its own, and is told once the run's write holding its context commits.
    pub(crate) binder: Arc<dyn SessionRunBinder>,
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
    run_limits: Arc<dyn WorkflowRunLimits>,
    kept_values: Arc<WorkflowKeptValueStore>,
    kinds: Arc<NodeKindTable>,
    binder: Arc<dyn SessionRunBinder>,
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
            run_limits,
            kept_values,
            kinds,
            binder,
            data_folder,
            recorder,
        } = dependencies;
        Self {
            pool,
            appender: SessionEventAppender::new(event_log, SESSION_EVENT_VERSION.clone()),
            machines,
            authorizer,
            payloads,
            run_limits,
            kept_values,
            kinds,
            binder,
            data_folder,
            recorder,
        }
    }

    /// Starts `start`'s run: checks it, prepares its folder, a project session's run bound to that
    /// session's workspace and a named project's run in a workspace of its own, reads the scope
    /// its steps share, builds its trigger input, then writes its row, its execution context and
    /// its `workflow.run.started` together, the event's instant the row's start, the context's and
    /// the scope's. A run joining a chain at its limit is held, with nothing written. Fails with
    /// [`WorkflowRunStartError::Refused`] (`workflow.run.startDenied`,
    /// `workflow.run.projectOnProjectSession`, `project.notFound` for a named project with no
    /// attached folder, `workflow.run.inputRequired`, `workflow.run.repositoryRequired`,
    /// `workflow.run.providerRequired`, `workflow.run.nodeKindUnavailable`,
    /// `workflow.run.handleUndeclared`), [`WorkflowRunStartError::Version`]
    /// (`workflow.version.notFound`) or [`WorkflowRunStartError::Session`] (`session.notFound`)
    /// before anything is made, with [`WorkflowRunStartError::Binding`] when a run cannot be
    /// bound or its context's write is refused, and with the other variants when a read, the
    /// folder, the payload store or the write fails; the run's own folder, with its workflow's
    /// runs folder once that is empty, its stored trigger input and the workspace a named
    /// project's binding made go with every outcome but a start. A held start whose folder, stored
    /// input or workspace cannot be removed is still answered held, the removal's failure going to
    /// the engine's record.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the engine's run start handlers")
    )]
    pub(crate) async fn start(
        &self,
        start: WorkflowRunStart,
    ) -> Result<WorkflowStartOutcome, WorkflowRunStartError> {
        let checked = self.check(&start).await?;
        let workflow_run_id =
            WorkflowRunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        let is_run_owned = checked.project_root.is_some();
        let prepared = match self
            .prepare(start.session_id, workflow_run_id, &checked)
            .await
        {
            Ok(prepared) => prepared,
            Err(error) if is_run_owned => {
                return self
                    .discard_run_workspace(workflow_run_id, Err(error))
                    .await;
            }
            Err(error) => return Err(error),
        };
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
            && let Err((folder, removal)) = remove_run_folder(folder).await
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
        if is_run_owned {
            return self.discard_run_workspace(run_id, ended).await;
        }
        ended
    }

    // Deletes the workspace a named project's binding made for run `workflow_run_id`, which no
    // start made; a held start whose workspace cannot be deleted is still answered held, the
    // failure going to the engine's record.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the engine's run start handlers")
    )]
    async fn discard_run_workspace(
        &self,
        workflow_run_id: WorkflowRunId,
        ended: Result<WorkflowStartOutcome, WorkflowRunStartError>,
    ) -> Result<WorkflowStartOutcome, WorkflowRunStartError> {
        let Err(removal) = self.binder.discard_project_run(workflow_run_id).await else {
            return ended;
        };
        match ended {
            Ok(held) => {
                self.record_left_behind(workflow_run_id, &removal).await;
                Ok(held)
            }
            Err(error) => Err(WorkflowRunStartError::WorkspaceLeft {
                workflow_run_id,
                ended: Box::new(error),
                removal,
            }),
        }
    }

    // Records what a held start could not remove, under the run id it minted, then ends that run's
    // record, since a held start makes no run.
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
        self.recorder.end_run(run_id);
    }

    // Takes the run's start, binds a project session's run to that session's workspace and a named
    // project's run in a workspace of its own, whose root the run works in, and makes the run's
    // own folder where neither binds and the session has none.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the engine's run start handlers")
    )]
    async fn prepare(
        &self,
        session_id: SessionId,
        workflow_run_id: WorkflowRunId,
        checked: &CheckedStart,
    ) -> Result<PreparedStart, WorkflowRunStartError> {
        let started_at = WireInstant::now();
        let binding = match (&checked.project_root, checked.session.shape) {
            (Some(root), _) => Some(
                self.binder
                    .bind_project_run(session_id, workflow_run_id, root)
                    .await
                    .map_err(WorkflowRunStartError::Binding)?,
            ),
            // The workflow's name stands for a chat's first message in a new tree's name.
            (None, SessionShape::Project) => Some(
                self.binder
                    .bind_session_run(
                        session_id,
                        workflow_run_id.text().as_str(),
                        checked.workflow_name.as_str(),
                    )
                    .await
                    .map_err(WorkflowRunStartError::Binding)?,
            ),
            (None, SessionShape::Chat) => None,
        };
        let folder = if let Some(binding) = &binding {
            RunFolder::Session(binding.execution_root().to_path_buf())
        } else if let Some(folder) = &checked.session.working_folder {
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
            binding,
        })
    }

    // What the run's scope reads beside its version and its workflow's row: the stored pins parsed
    // and hashed for a manual run only, one pooled read of the project's environment rows, by the
    // bound workspace's mount where the run is bound, and the session's project, then the
    // workflow's kept values.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the engine's run start handlers")
    )]
    async fn read_scope(
        &self,
        session_id: SessionId,
        mode: WorkflowRunMode,
        checked: &CheckedStart,
        binding: Option<&RunContextBinding>,
    ) -> Result<ScopeReads, WorkflowRunStartError> {
        let pins = hash_run_pins(checked.pin_data_json.as_deref(), mode)?;
        let session = checked.session.clone();
        let bound_mount = binding.map(RunContextBinding::repo_mount_id);
        let (environment_rows, project) = self
            .pool
            .read(ReadLength::Short, move |connection| {
                let environment_rows = match bound_mount {
                    Some(repo_mount_id) => read_mount_environment_rows(connection, repo_mount_id)?,
                    None => read_project_environment_rows(connection, &session)?,
                };
                let project = read_session_project(connection, &session_id)?;
                Ok::<_, WorkflowRunStartError>((environment_rows, project))
            })
            .await?;
        let kept_values = self.kept_values.read(checked.definition_id).await?;
        Ok(ScopeReads {
            pins,
            environment_rows,
            project,
            kept_values,
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
        write_step_payload(&*self.payloads, session_id, trigger_step, items)
            .await
            .map_err(|error| match error {
                StepPayloadWriteError::Json(error) => WorkflowRunStartError::InputJson(error),
                StepPayloadWriteError::Artifact(error) => WorkflowRunStartError::Payload(error),
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
            project_id,
            mode,
            started_by,
            chain,
            ..
        } = start;
        let workflow_run_id = prepared.workflow_run_id;
        let scope_reads = self
            .read_scope(session_id, mode, &checked, prepared.binding.as_ref())
            .await?;
        let trigger_step = trigger_step_key(workflow_run_id, &checked.trigger_node);
        let trigger_input = self
            .trigger_input(session_id, &trigger_step, &checked.start_items)
            .await?;
        if let WorkflowPayloadRef::Artifact { artifact_id, .. } = &trigger_input {
            *stored_input = Some(*artifact_id);
        }
        // The limit is read at each joining start, so a changed setting holds the next one.
        let chain_ask_after = match chain {
            WorkflowRunChainPlace::Joins { .. } => self.run_limits.chain_ask_after_runs(),
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
            execution_context: prepared
                .binding
                .as_ref()
                .map(|binding| context_statement(binding, &prepared.started_at)),
            provider: checked.provider.clone(),
            started_at: prepared.started_at.clone(),
            trigger_input: Some(trigger_input.clone()),
            node_run: None,
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
                provider: checked.provider.clone(),
                node_run: None,
                input_ref: Some(trigger_input.clone()),
            }),
        )?;
        // The checkout's lock spans the one write of the run's context, as the agent run's does.
        let checkout_hold = match &prepared.binding {
            Some(binding) => Some(self.binder.hold_checkout(binding).await),
            None => None,
        };
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
        drop(checkout_hold);
        let context_index = execution_context_statement_index(&chain);
        match (appended, chain) {
            (Ok(receipt), _) => {
                if prepared.binding.is_some() {
                    self.binder.note_context_changed(session_id);
                }
                let node_params = checked
                    .nodes
                    .iter()
                    .map(|(node_id, node)| (node_id.clone(), node.params.clone()))
                    .collect();
                let scope = RunScope {
                    session_id,
                    run_id: workflow_run_id,
                    workflow_id: checked.definition_id,
                    workflow_version_id,
                    workflow_name: checked.workflow_name,
                    mode,
                    retried_mode: None,
                    trigger: checked.trigger_node,
                    nodes: checked.nodes,
                    node_params: Arc::new(node_params),
                    pins: scope_reads.pins,
                    run_started_at: prepared
                        .started_at
                        .timestamp()
                        .expect("a minted instant reads as a timestamp"),
                    time_zone: TimeZone::system(),
                    environment_rows: Arc::from(scope_reads.environment_rows),
                    kept_values: Arc::from(scope_reads.kept_values),
                    // A named project is the run's; else the session's own, if any.
                    project: project_id.or(scope_reads.project),
                    working_folder: prepared.folder.path().to_path_buf(),
                    provider: checked.provider,
                    redaction: Arc::new(RunRedaction::new(&[])),
                    cancel: CancellationToken::new(),
                };
                Ok(WorkflowStartOutcome::Started(StartedRun {
                    scope: Arc::new(scope),
                    graph: checked.graph,
                    trigger_input,
                    trigger_items: checked.start_items,
                    started_sequence: receipt.sequence,
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
            (Err(error), _) => match &prepared.binding {
                Some(binding) if error.refused_statement_index() == Some(context_index) => Err(
                    WorkflowRunStartError::Binding(context_write_refusal(binding, error)),
                ),
                Some(_) | None => Err(WorkflowRunStartError::Append(error)),
            },
        }
    }
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

/// The pins a run of `mode` honors, each node's items with their content hash taken once here: the
/// stored `pin_data_json` parsed for a manual run, and none, unread, for any other. Refuses pins
/// that do not parse or whose items do not canonicalize.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the engine's run start handlers")
)]
pub(crate) fn hash_run_pins(
    pin_data_json: Option<&str>,
    mode: WorkflowRunMode,
) -> Result<HashMap<WorkflowNodeId, RunPin>, WorkflowRunStartError> {
    if mode != WorkflowRunMode::Manual {
        return Ok(HashMap::new());
    }
    pin_data_json
        .map(parse_stored_pin_data)
        .transpose()?
        .map(Record::into_map)
        .unwrap_or_default()
        .into_iter()
        // An empty key names no node, so no step gives its pin, as with a key naming a node the
        // version lacks.
        .filter_map(|(node_id, items)| Some((WorkflowNodeId::new(node_id)?, items)))
        .map(|(node_id, items)| {
            let hash = hash_canonical_json(
                &serde_json::to_value(&items).map_err(CanonicalizationRefusal::from)?,
            )?;
            Ok((node_id, RunPin { items, hash }))
        })
        .collect()
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
