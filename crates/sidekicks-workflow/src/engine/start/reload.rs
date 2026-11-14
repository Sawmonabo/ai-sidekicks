//! The restart's read of a session's unfinished runs, which the tick takes back: each run's row,
//! the scope its steps share rebuilt from what its start stored, its pinned version's graph, its
//! steps not yet settled and its workflow events in log order. Before it, what a start left behind
//! when a stop cut it before its run's row is deleted: the workspace it bound for its run, and the
//! payloads it stored that nothing written names.
#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's restart, which hands each recovered session's runs to the tick"
    )
)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};

use jiff::tz::TimeZone;
use rusqlite::{Connection, Row, named_params};
use serde_json::Value;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::{SessionEvent, SessionEventReadError};
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionShape;
use sidekicks_contracts::wire::id::UuidTextForm;
use sidekicks_contracts::wire::instant::{NotAnInstant, WireInstant};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowName, WorkflowNode, WorkflowNodeId, WorkflowVersionId,
};
use sidekicks_contracts::workflow::definition::item::WorkflowStepError;
use sidekicks_contracts::workflow::run::events::WorkflowNodeRun;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::{
    WorkflowRunStatus, WorkflowStepStatus, WorkflowWaitCause,
};
use sidekicks_contracts::workflow::run::step::record::{WorkflowPayloadRef, WorkflowStepKey};
use sidekicks_contracts::workflow::run::trigger::{WorkflowRunMode, WorkflowRunTrigger};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_store::data_folder::workflow_run_folder;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::sql_list::sql_list_of;
use sidekicks_store::database::stored_column::{closed_word, optional_text_column, text_column};
use sidekicks_store::events::session::read::{
    SessionEventFilter, SessionEventReads, SessionLogReadError,
};
use sidekicks_workspace::run_setup_gates::RunSetupGateError;
use sidekicks_workspace::run_setup_gates::execution_root::context::SessionRunBinder;
use sidekicks_workspace::working_folder::{
    ProjectEnvironmentReadError, WorkingFolderReadError, read_mount_environment_rows,
    read_project_environment_rows, read_working_folder,
};
use tokio_util::sync::CancellationToken;

use super::{check_run_graph, hash_pin_data, read_session_project};
use crate::definitions::kept_values::{WorkflowKeptValueError, WorkflowKeptValueStore};
use crate::definitions::stored_document::parse_stored_workflow_body;
use crate::definitions::versions::history::{WorkflowVersions, WorkflowVersionsError};
use crate::engine::partial_run::covered_places;
use crate::engine::ports::{PortError, StepPayloadArtifacts};
use crate::engine::results::run_posts_results;
use crate::engine::tick::run_status::RunPersonWait;
use crate::engine::tick::{RunGraph, RunScope};
use crate::engine::waits::step_key;
use crate::kinds::{NodeKindTable, coded_step_error, uncoded_step_error};
use crate::runs::gate_resolution::RunEventKeys;
use crate::runs::projection::suspended_step;
use crate::runs::record::FIRST_NON_RETRY_MODE_SQL;
use crate::secrets::redaction::RunRedaction;

// The session's unfinished runs, each with the root, mount and project of the context it holds
// where it works in a project's repository, oldest first.
const UNFINISHED_RUNS_SQL: &str = "SELECT run.id, run.workflow_version_id, run.provider,
    run.status, run.mode, run.trigger_json, run.node_run_json, run.retried_run_id,
    run.started_at, run.person_wait_since, run.person_wait_ms, context.execution_root,
    workspace.repo_mount_id, mount.project_id
  FROM workflow_runs AS run
  LEFT JOIN run_execution_contexts AS context
    ON context.run_id = run.id AND context.released_at IS NULL
  LEFT JOIN workspaces AS workspace ON workspace.id = context.workspace_id
  LEFT JOIN repo_mounts AS mount ON mount.id = workspace.repo_mount_id
  WHERE run.session_id = ?1 AND run.finished_at IS NULL
  ORDER BY run.started_at, run.id";

// The runs a workspace of the session was bound for that have no row: a start a stop cut between
// its workspace's bind and its run's row.
const STRANDED_RUN_WORKSPACES_SQL: &str = "SELECT workflow_run_id FROM workspaces
  WHERE session_id = ?1 AND workflow_run_id IS NOT NULL
    AND workflow_run_id NOT IN (SELECT id FROM workflow_runs)";

const SESSION_RUN_IDS_SQL: &str = "SELECT id FROM workflow_runs WHERE session_id = ?1";

// Of the artifacts a JSON list of their ids names, bound second, those that no event of the
// session, bound first, and no row of its runs or their steps names anywhere in its text, so a
// payload a reader could still reach is never among them.
const UNNAMED_PAYLOADS_SQL: &str = "SELECT candidate.value FROM json_each(?2) AS candidate
  WHERE NOT EXISTS (SELECT 1 FROM session_events AS event
                     WHERE event.session_id = ?1 AND instr(event.payload, candidate.value) > 0)
    AND NOT EXISTS (SELECT 1 FROM workflow_runs AS run
                     WHERE run.session_id = ?1
                       AND instr(run.trigger_json || coalesce(run.node_run_json, ''),
                                 candidate.value) > 0)
    AND NOT EXISTS (SELECT 1 FROM workflow_steps AS step
                      JOIN workflow_runs AS run ON run.id = step.workflow_run_id
                     WHERE run.session_id = ?1
                       AND instr(step.input_ref || step.output_ref || step.log_ref,
                                 candidate.value) > 0)";

// A run's steps not settled, and its failed and canceled ones, which a park keeps for its
// Resume, in execution order.
static KEPT_STEPS_SQL: LazyLock<String> = LazyLock::new(|| {
    let kept = sql_list_of(
        [
            WorkflowStepStatus::Pending,
            WorkflowStepStatus::WaitingMemory,
            WorkflowStepStatus::Running,
            WorkflowStepStatus::Waiting,
            WorkflowStepStatus::Failed,
            WorkflowStepStatus::Canceled,
        ]
        .map(<&'static str>::from),
    );
    format!(
        "SELECT workflow_run_id, node_id, attempt, execution_index, status, wait_cause, wait_id,
    wait_deadline_at, resume_at, input_ref
  FROM workflow_steps WHERE workflow_run_id = ?1 AND status IN ({kept})
  ORDER BY execution_index"
    )
});

// How the first run of a retry's chain of retries that is not a retry was started.
static FIRST_MODE_OF_RUN_SQL: LazyLock<String> =
    LazyLock::new(|| format!("SELECT {}", *FIRST_NON_RETRY_MODE_SQL));

/// The events the restart replays: a run's start, failed park and Resume, and each step's hold,
/// admission, wait, wind-down, retry and settlement.
const REPLAYED_EVENT_TYPES: [SessionEventType; 12] = [
    SessionEventType::WorkflowRunStarted,
    SessionEventType::WorkflowRunFailed,
    SessionEventType::WorkflowRunResumed,
    SessionEventType::WorkflowPhaseWaitingOnMemory,
    SessionEventType::WorkflowPhaseAdmitted,
    SessionEventType::WorkflowPhaseSuspended,
    SessionEventType::WorkflowPhaseCanceling,
    SessionEventType::WorkflowPhaseRetried,
    SessionEventType::WorkflowStepCompleted,
    SessionEventType::WorkflowStepFailed,
    SessionEventType::WorkflowStepCanceled,
    SessionEventType::WorkflowStepSkipped,
];

/// One unfinished run as the restart read it: the keys its events name, whether a step of it was
/// ever admitted, its person-wait columns, its steps not yet settled, its events in log order,
/// and what it runs on, or why it cannot run again.
pub(crate) struct ReloadedRun {
    /// The session, definition and version its events name.
    pub(crate) keys: RunEventKeys,
    /// The run.
    pub(crate) run_id: WorkflowRunId,
    /// Whether its row had left `new`, which the first admission of a step does.
    pub(crate) is_admitted: bool,
    /// Its person-wait columns as its row stores them.
    pub(crate) person_wait: RunPersonWait,
    /// Whether its ending posts its results, as its mode and its chain's first mode decide.
    pub(crate) posts_results: bool,
    /// Its steps not settled, failed or canceled, in execution order.
    pub(crate) steps: Vec<ReloadedStep>,
    /// Its events the restart replays, in log order, each with its sequence and instant.
    pub(crate) events: Vec<ReplayedEvent>,
    /// What the run runs on, or the error its crashed ending carries where its version, its
    /// graph or its pins no longer read.
    pub(crate) drive: Result<ReloadedScope, WorkflowStepError>,
}

/// One event of a reloaded run: its sequence in the session's log, its instant and itself.
pub(crate) struct ReplayedEvent {
    /// Its sequence.
    pub(crate) sequence: SafeInt<0>,
    /// When it happened.
    pub(crate) at: WireInstant,
    /// The event.
    pub(crate) event: SessionEvent,
}

/// What a reloaded run runs on: its scope, its pinned version's graph, and for a node run the
/// places it covers and its target's place.
pub(crate) struct ReloadedScope {
    /// What the run's steps share.
    pub(crate) scope: Arc<RunScope>,
    /// The graph of its pinned version.
    pub(crate) graph: Arc<RunGraph>,
    /// The places a node run covers, by place; `None` for a run that covers every place.
    pub(crate) covered: Option<Arc<[bool]>>,
    /// A node run's target's place, whose outputs feed nothing; `None` for any other run.
    pub(crate) sealed: Option<usize>,
    /// Each version a Resume moved the run to, in log order.
    pub(crate) repins: Vec<ReloadedRepin>,
}

/// A version a reloaded run moved to on a Resume, as the restart found its kinds: the version,
/// the workflow's name there, its nodes by id and its run graph.
pub(crate) struct ReloadedRepin {
    /// The version.
    pub(crate) workflow_version_id: WorkflowVersionId,
    /// The workflow's name in it.
    pub(crate) workflow_name: WorkflowName,
    /// Its nodes by id, the trigger included.
    pub(crate) nodes: HashMap<WorkflowNodeId, WorkflowNode>,
    /// Its run graph.
    pub(crate) graph: Arc<RunGraph>,
}

/// A step of a reloaded run not settled, failed or canceled, as its row stores it.
pub(crate) struct ReloadedStep {
    /// The step.
    pub(crate) step: WorkflowStepKey,
    /// Where it stands.
    pub(crate) status: WorkflowStepStatus,
    /// What it waits on, while it is `waiting`.
    pub(crate) wait_cause: Option<WorkflowWaitCause>,
    /// The person wait it waits on, which an answer names.
    pub(crate) wait_id: Option<UuidTextForm>,
    /// When its person wait gives up, where the wait has a deadline.
    pub(crate) wait_deadline_at: Option<WireInstant>,
    /// When it resumes itself from its spent account's wait: the instant, or the stored text
    /// that does not read as one.
    pub(crate) resume_at: Option<Result<WireInstant, UnreadableResume>>,
    /// Its input as its row stores it.
    pub(crate) input_ref: WorkflowPayloadRef,
}

/// A step's stored resume that does not read as an instant.
#[derive(Debug, thiserror::Error)]
#[error("the stored resume {value:?} does not read as an instant")]
pub(crate) struct UnreadableResume {
    /// The stored text.
    pub(crate) value: String,
}

/// Why a session's unfinished runs could not be read back.
#[derive(Debug, thiserror::Error)]
pub(crate) enum RunReloadError {
    /// No read connection answered.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// A run or step row did not read.
    #[error("a run's rows did not read")]
    Database(#[from] rusqlite::Error),
    /// A run's pinned version has no row.
    #[error(transparent)]
    Version(#[from] WorkflowVersionsError),
    /// The session's folder did not read.
    #[error(transparent)]
    Session(#[from] WorkingFolderReadError),
    /// The environment rows of a run's project did not read.
    #[error(transparent)]
    ProjectEnvironment(#[from] ProjectEnvironmentReadError),
    /// A workflow's kept values did not read.
    #[error(transparent)]
    KeptValues(#[from] WorkflowKeptValueError),
    /// The session's log did not read.
    #[error(transparent)]
    Log(#[from] SessionLogReadError),
    /// A stored workflow event did not read as its type.
    #[error(transparent)]
    Event(#[from] SessionEventReadError),
    /// A stored event's instant did not read as one.
    #[error("a stored event's instant does not read as an instant")]
    Instant(#[from] NotAnInstant),
    /// A workspace bound for a run that has no row could not be deleted.
    #[error("a workspace a stop left with no run could not be deleted")]
    StrandedWorkspace(#[source] Box<RunSetupGateError>),
    /// The payloads a stop left that nothing names could not be listed or deleted.
    #[error("a payload a stop left with nothing naming it could not be listed or deleted")]
    StrandedPayload(#[source] PortError),
}

/// Reads a session's unfinished runs back for the tick at the restart.
pub(crate) struct RunReloader {
    /// The read pool every read of a reload goes through.
    pub(crate) pool: Arc<DatabaseReadPool>,
    /// The kinds a run's graph is built over.
    pub(crate) kinds: Arc<NodeKindTable>,
    /// The values each workflow keeps, which its runs read.
    pub(crate) kept_values: Arc<WorkflowKeptValueStore>,
    /// The data folder a run's own folder sits in.
    pub(crate) data_folder: PathBuf,
    /// The binder that deletes a workspace bound for a run that never got its row.
    pub(crate) binder: Arc<dyn SessionRunBinder>,
    /// The payload store whose payloads a stop left with nothing naming them are deleted.
    pub(crate) payloads: Arc<dyn StepPayloadArtifacts>,
}

/// One unfinished run's row, as the reload reads it.
struct RunRow {
    run_id: WorkflowRunId,
    workflow_version_id: WorkflowVersionId,
    provider: Option<ProviderId>,
    status: WorkflowRunStatus,
    mode: WorkflowRunMode,
    trigger: WorkflowRunTrigger,
    node_run: Option<WorkflowNodeRun>,
    is_retry: bool,
    started_at: WireInstant,
    person_wait: RunPersonWait,
    execution_root: Option<PathBuf>,
    repo_mount_id: Option<RepoMountId>,
    project_id: Option<ProjectId>,
}

impl RunReloader {
    /// The unfinished runs of `session_id`, oldest first, each with its scope rebuilt: the
    /// version and the provider its row pins, the pins its start event stores, the folder of the
    /// context it holds, else the session's, else its own, the environment rows and project of
    /// its repository, and its workflow's kept values. A run whose version, graph or pins no
    /// longer read carries the error its crashed ending stores in place of a scope. First it
    /// deletes what a start a stop cut before its run's row left: the workspace bound for that run
    /// and every payload stored in the session under another run's step that nothing written
    /// names. It runs for every recovered session, unfinished runs or not, before the session
    /// takes a start, since a start under way holds such a workspace and such payloads. Fails as
    /// [`RunReloadError`] when a read of the session's rows, kept values or log fails, or a
    /// leftover cannot be deleted.
    pub(crate) async fn reload_session(
        &self,
        session_id: SessionId,
    ) -> Result<Vec<ReloadedRun>, RunReloadError> {
        self.delete_stop_leftovers(session_id).await?;
        let kinds = Arc::clone(&self.kinds);
        let data_folder = self.data_folder.clone();
        let mut runs = self
            .pool
            .read(ReadLength::Long, move |connection| {
                read_session_runs(connection, session_id, &kinds, &data_folder)
            })
            .await?;
        for run in &mut runs {
            let Ok(reloaded) = &mut run.drive else {
                continue;
            };
            let kept_values = self.kept_values.read(run.keys.definition_id).await?;
            let scope = Arc::get_mut(&mut reloaded.scope).expect("a scope just read is unshared");
            scope.kept_values = Arc::from(kept_values);
        }
        Ok(runs)
    }

    // Deletes each workspace bound for a run of the session that has no row, then each payload
    // stored in the session under a step of a run not the session's that nothing written names:
    // a trigger input stored before a stop cut its run's row, or a copy of another session's
    // output made for a run that never started.
    async fn delete_stop_leftovers(&self, session_id: SessionId) -> Result<(), RunReloadError> {
        let (stranded_runs, session_runs) = self
            .pool
            .read(ReadLength::Short, move |connection| {
                Ok::<_, RunReloadError>((
                    read_run_ids(connection, STRANDED_RUN_WORKSPACES_SQL, session_id)?,
                    read_run_ids(connection, SESSION_RUN_IDS_SQL, session_id)?,
                ))
            })
            .await?;
        for workflow_run_id in stranded_runs {
            self.binder
                .discard_project_run(workflow_run_id)
                .await
                .map_err(|error| RunReloadError::StrandedWorkspace(Box::new(error)))?;
        }
        let candidates = self
            .payloads
            .payloads_of_other_runs(session_id, &session_runs)
            .await
            .map_err(RunReloadError::StrandedPayload)?;
        if candidates.is_empty() {
            return Ok(());
        }
        let candidates_json =
            serde_json::to_string(&candidates).expect("artifact ids write as JSON");
        let unnamed = self
            .pool
            .read(ReadLength::Long, move |connection| {
                connection
                    .prepare_cached(UNNAMED_PAYLOADS_SQL)?
                    .query_map(
                        (session_id.text().as_str(), candidates_json.as_str()),
                        |row| text_column(row, 0, |text| ArtifactId::new(&text)),
                    )?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(RunReloadError::from)
            })
            .await?;
        for artifact_id in &unnamed {
            self.payloads
                .delete(artifact_id)
                .await
                .map_err(RunReloadError::StrandedPayload)?;
        }
        Ok(())
    }
}

// The run ids `sql`, binding `session_id` first, selects on `connection`.
fn read_run_ids(
    connection: &Connection,
    sql: &str,
    session_id: SessionId,
) -> Result<Vec<WorkflowRunId>, RunReloadError> {
    Ok(connection
        .prepare_cached(sql)?
        .query_map([session_id.text().as_str()], |row| {
            text_column(row, 0, |text| WorkflowRunId::new(&text))
        })?
        .collect::<Result<_, _>>()?)
}

/// The unfinished runs of `session_id` read on `connection`, their scopes built over `kinds`, a
/// run with no folder of its own named under `data_folder`; kept values are left for the caller.
fn read_session_runs(
    connection: &Connection,
    session_id: SessionId,
    kinds: &NodeKindTable,
    data_folder: &std::path::Path,
) -> Result<Vec<ReloadedRun>, RunReloadError> {
    let rows = connection
        .prepare_cached(UNFINISHED_RUNS_SQL)?
        .query_map([session_id.text().as_str()], run_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let session = read_working_folder(connection, &session_id)?;
    let session_project = read_session_project(connection, &session_id)?;
    let mut events = read_run_events(connection, &session_id)?;
    let mut runs = Vec::with_capacity(rows.len());
    for row in rows {
        let steps = connection
            .prepare_cached(KEPT_STEPS_SQL.as_str())?
            .query_map([row.run_id.text().as_str()], reloaded_step)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let run_events = events.remove(&row.run_id).unwrap_or_default();
        // The walk is replayed from the version the run started on; each re-pin moves it on.
        let started_version = run_events
            .iter()
            .find_map(|replayed| {
                if let SessionEvent::WorkflowRunStarted(started) = &replayed.event {
                    Some(started.workflow_version_id)
                } else {
                    None
                }
            })
            .unwrap_or(row.workflow_version_id);
        let version = WorkflowVersions::new(connection).read_version(started_version)?;
        let keys = RunEventKeys {
            session_id,
            definition_id: version.definition_id,
            workflow_version_id: row.workflow_version_id,
        };
        // The run gives the pins it started on, whatever its workflow pins now.
        let pin_data = run_events.iter().find_map(|replayed| {
            if let SessionEvent::WorkflowRunStarted(started) = &replayed.event {
                started.pin_data.clone()
            } else {
                None
            }
        });
        let retried_mode = if row.is_retry {
            connection
                .prepare_cached(FIRST_MODE_OF_RUN_SQL.as_str())?
                .query_row(
                    named_params! { "@run_id": row.run_id.text().as_str() },
                    |first| optional_text_column(first, 0, closed_word),
                )?
        } else {
            None
        };
        let environment_rows = match row.repo_mount_id {
            Some(repo_mount_id) => read_mount_environment_rows(connection, repo_mount_id)?,
            None => read_project_environment_rows(connection, &session)?,
        };
        let works_in_repository =
            row.execution_root.is_some() || session.shape == SessionShape::Project;
        let has_provider = row.provider.is_some();
        let version_graph =
            |body: &str| run_version_graph(kinds, body, works_in_repository, has_provider);
        let mut repins = Vec::new();
        for replayed in &run_events {
            let SessionEvent::WorkflowRunResumed(resumed) = &replayed.event else {
                continue;
            };
            let Some(joined) = resumed.repinned_to_workflow_version_id else {
                continue;
            };
            let target = WorkflowVersions::new(connection).read_version(joined)?;
            repins.push(version_graph(&target.definition_body).map(
                |(workflow_name, nodes, graph)| ReloadedRepin {
                    workflow_version_id: joined,
                    workflow_name,
                    nodes,
                    graph: Arc::new(graph),
                },
            ));
        }
        let built = version_graph(&version.definition_body).and_then(|built| {
            let repins = repins.into_iter().collect::<Result<Vec<_>, _>>()?;
            match hash_pin_data(pin_data.unwrap_or_default()) {
                Ok(pins) => Ok((built, pins, repins)),
                Err(error) => Err(Box::new(uncoded_step_error(error.to_string()))),
            }
        });
        let drive = built.map(|((workflow_name, nodes, graph), pins, repins)| {
            let covered = row.node_run.as_ref().map(|node_run| {
                let mut covered = vec![false; graph.node_count()];
                for place in covered_places(&graph, graph.place(&node_run.node_id)) {
                    covered[place] = true;
                }
                Arc::from(covered)
            });
            let sealed = row
                .node_run
                .as_ref()
                .map(|node_run| graph.place(&node_run.node_id));
            let working_folder = row
                .execution_root
                .clone()
                .or_else(|| session.working_folder.clone())
                .unwrap_or_else(|| {
                    workflow_run_folder(data_folder, &version.definition_id, &row.run_id)
                });
            let node_params = nodes
                .iter()
                .map(|(node_id, node)| (node_id.clone(), node.params.clone()))
                .collect();
            let scope = RunScope {
                session_id,
                run_id: row.run_id,
                workflow_id: version.definition_id,
                workflow_version_id: row.workflow_version_id,
                workflow_name,
                mode: row.mode,
                retried_mode,
                trigger: row.trigger.clone(),
                nodes,
                node_params: Arc::new(node_params),
                pins,
                run_started_at: row
                    .started_at
                    .timestamp()
                    .expect("a stored start reads as a timestamp"),
                time_zone: TimeZone::system(),
                environment_rows: Arc::from(environment_rows.clone()),
                kept_values: Arc::new([]),
                project: row.project_id.or(session_project),
                working_folder,
                provider: row.provider.clone(),
                redaction: Arc::new(RunRedaction::new(&[])),
                cancel: CancellationToken::new(),
            };
            ReloadedScope {
                scope: Arc::new(scope),
                graph: Arc::new(graph),
                covered,
                sealed,
                repins,
            }
        });
        let drive = drive.map_err(|error| *error);
        runs.push(ReloadedRun {
            keys,
            run_id: row.run_id,
            is_admitted: row.status != WorkflowRunStatus::New,
            person_wait: row.person_wait,
            posts_results: run_posts_results(row.mode, retried_mode),
            steps,
            events: run_events,
            drive,
        });
    }
    Ok(runs)
}

/// The name, nodes and run graph of the version whose stored body is `body`, checked over `kinds`
/// as a start checks it; the error a crashed ending stores where it no longer reads or checks,
/// boxed for its size.
fn run_version_graph(
    kinds: &NodeKindTable,
    body: &str,
    works_in_repository: bool,
    has_provider: bool,
) -> Result<
    (
        WorkflowName,
        HashMap<WorkflowNodeId, WorkflowNode>,
        RunGraph,
    ),
    Box<WorkflowStepError>,
> {
    let body = parse_stored_workflow_body(body)
        .map_err(|error| Box::new(uncoded_step_error(error.to_string())))?;
    let (nodes, graph) = check_run_graph(kinds, &body, works_in_repository, has_provider)
        .map_err(|refusal| Box::new(refused_error(&refusal)))?;
    Ok((body.name, nodes, graph))
}

/// The run row the columns of [`UNFINISHED_RUNS_SQL`] read.
fn run_row(row: &Row<'_>) -> rusqlite::Result<RunRow> {
    let person_wait_ms: i64 = row.get(10)?;
    Ok(RunRow {
        run_id: text_column(row, 0, |text| WorkflowRunId::new(&text))?,
        workflow_version_id: text_column(row, 1, |text| WorkflowVersionId::new(&text))?,
        provider: optional_text_column(row, 2, closed_word)?,
        status: text_column(row, 3, closed_word)?,
        mode: text_column(row, 4, closed_word)?,
        trigger: text_column(row, 5, |text| serde_json::from_str(&text))?,
        node_run: optional_text_column(row, 6, |text| serde_json::from_str(&text))?,
        is_retry: row.get::<_, Option<String>>(7)?.is_some(),
        started_at: text_column(row, 8, WireInstant::try_from)?,
        person_wait: RunPersonWait {
            since: optional_text_column(row, 9, WireInstant::try_from)?,
            total_ms: u64::try_from(person_wait_ms).unwrap_or(0),
        },
        execution_root: row.get::<_, Option<String>>(11)?.map(PathBuf::from),
        repo_mount_id: optional_text_column(row, 12, |text| RepoMountId::new(&text))?,
        project_id: optional_text_column(row, 13, |text| ProjectId::new(&text))?,
    })
}

/// The step row the columns of [`KEPT_STEPS_SQL`] read, its resume kept as stored where it
/// does not read as an instant.
fn reloaded_step(row: &Row<'_>) -> rusqlite::Result<ReloadedStep> {
    let resume_at = row.get::<_, Option<String>>(8)?.map(|value| {
        WireInstant::try_from(value.clone()).map_err(|_unread| UnreadableResume { value })
    });
    Ok(ReloadedStep {
        step: step_key(row)?,
        status: text_column(row, 4, closed_word)?,
        wait_cause: optional_text_column(row, 5, closed_word)?,
        wait_id: optional_text_column(row, 6, |text| UuidTextForm::new(&text))?,
        wait_deadline_at: optional_text_column(row, 7, WireInstant::try_from)?,
        resume_at,
        input_ref: text_column(row, 9, |text| serde_json::from_str(&text))?,
    })
}

/// The events of `session_id` the restart replays, by run, each run's in log order.
fn read_run_events(
    connection: &Connection,
    session_id: &SessionId,
) -> Result<HashMap<WorkflowRunId, Vec<ReplayedEvent>>, RunReloadError> {
    let event_types = REPLAYED_EVENT_TYPES.map(SessionEventType::as_str);
    let envelopes = SessionEventReads::new(connection, |_: &SessionId| None).read_after(
        session_id,
        -1,
        -1,
        SessionEventFilter {
            event_types: Some(&event_types),
            ..SessionEventFilter::default()
        },
    )?;
    let mut by_run: HashMap<WorkflowRunId, Vec<ReplayedEvent>> = HashMap::new();
    for envelope in &envelopes {
        let (run_id, replayed) = replayed_event(envelope)?;
        by_run.entry(run_id).or_default().push(replayed);
    }
    Ok(by_run)
}

/// The run `envelope` names beside the event it holds. Fails when the stored event does not read.
#[expect(
    clippy::wildcard_enum_match_arm,
    reason = "the read takes only the replayed event types, each named here"
)]
fn replayed_event(
    envelope: &EventEnvelope,
) -> Result<(WorkflowRunId, ReplayedEvent), RunReloadError> {
    let event = SessionEvent::from_envelope(envelope)?;
    let at = WireInstant::try_from(envelope.occurred_at.as_str().to_owned())?;
    let run_id = match &event {
        SessionEvent::WorkflowRunStarted(payload) => payload.workflow_run_id,
        SessionEvent::WorkflowRunFailed(payload) => payload.workflow_run_id,
        SessionEvent::WorkflowRunResumed(payload) => payload.workflow_run_id,
        SessionEvent::WorkflowPhaseWaitingOnMemory(payload) => payload.workflow_run_id,
        SessionEvent::WorkflowPhaseAdmitted(payload) => payload.workflow_run_id,
        SessionEvent::WorkflowPhaseSuspended(payload) => suspended_step(payload).workflow_run_id,
        SessionEvent::WorkflowPhaseCanceling(payload) => payload.workflow_run_id,
        SessionEvent::WorkflowPhaseRetried(payload) => payload.workflow_run_id,
        SessionEvent::WorkflowStepCompleted(payload) => payload.workflow_run_id,
        SessionEvent::WorkflowStepFailed(payload) => payload.workflow_run_id,
        SessionEvent::WorkflowStepCanceled(payload) => payload.workflow_run_id,
        SessionEvent::WorkflowStepSkipped(payload) => payload.workflow_run_id,
        _ => unreachable!("the read takes only the replayed types"),
    };
    Ok((
        run_id,
        ReplayedEvent {
            sequence: envelope.sequence,
            at,
            event,
        },
    ))
}

/// The error a run's crashed ending stores for `refusal`, the graph check's refusal of its version
/// as the restart found the kinds.
fn refused_error(refusal: &DomainError) -> WorkflowStepError {
    let details = refusal
        .detail
        .as_deref()
        .cloned()
        .map_or_else(|| Value::Object(serde_json::Map::new()), Value::Object);
    coded_step_error(refusal.code, refusal.message.clone(), details, None)
}
