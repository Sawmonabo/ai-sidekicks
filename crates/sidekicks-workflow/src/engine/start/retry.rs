//! A retry from a named step: a new run of its source run's pinned version, in the session that
//! run lives in and where it worked, whose steps outside the named node and what that node feeds
//! reuse the source run's, so only the failed step and what follows it run again.

use std::sync::{Arc, LazyLock};

use rusqlite::{Connection, OptionalExtension, named_params};
use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::workflow::definition::document::{WorkflowNodeId, WorkflowVersionId};
use sidekicks_contracts::workflow::run::control::{
    WorkflowRunStillRunningDetails, WorkflowRunStillRunningReason,
};
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::{
    GOING_RUN_STATUSES, WorkflowRunStatus, WorkflowStepStatus,
};
use sidekicks_contracts::workflow::run::step::record::WorkflowPayloadRef;
use sidekicks_contracts::workflow::run::trigger::{
    WorkflowRunChainPlace, WorkflowRunMode, WorkflowRunTrigger, WorkflowStartedBy,
};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_store::database::connection::read_pool::{DatabaseReadError, ReadLength};
use sidekicks_store::database::stored_column::{closed_word, optional_text_column, text_column};

use super::{
    StartedNodeRun, StartedRun, WorkflowRunStart, WorkflowRunStartError, WorkflowRunStarter,
    WorkflowStartArrival, WorkflowStartOutcome,
};
use crate::engine::partial_run::plan_retry;
use crate::not_found::WorkflowNotFound;
use crate::runs::step_payload::read_step_payload;

// The source run's version, session, status and trigger, how the first run of its retries that is
// not a retry was started, followed through each retry's retried run, and the project of the
// workspace of its own it worked in, if any.
static SOURCE_RUN_SQL: LazyLock<String> = LazyLock::new(|| {
    let retry = <&'static str>::from(WorkflowRunMode::Retry);
    format!(
        "SELECT run.workflow_version_id, run.session_id, run.status, run.trigger_json,
    (WITH RECURSIVE retried(mode, retried_run_id) AS (
         SELECT mode, retried_run_id FROM workflow_runs WHERE id = @run_id
       UNION ALL
         SELECT earlier.mode, earlier.retried_run_id
           FROM workflow_runs AS earlier JOIN retried ON earlier.id = retried.retried_run_id)
     SELECT mode FROM retried WHERE mode <> '{retry}' LIMIT 1),
    (SELECT mount.project_id FROM workspaces AS workspace
       JOIN repo_mounts AS mount ON mount.id = workspace.repo_mount_id
      WHERE workspace.workflow_run_id = run.id)
  FROM workflow_runs AS run WHERE run.id = @run_id"
    )
});

// The status of a node's latest step in a run: its last execution, then its last attempt.
const LATEST_STEP_STATUS_SQL: &str = "SELECT status FROM workflow_steps
  WHERE workflow_run_id = @run_id AND node_id = @node_id
  ORDER BY execution_index DESC, attempt DESC LIMIT 1";

// The input a node's first step in a run started on.
const FIRST_STEP_INPUT_SQL: &str = "SELECT input_ref FROM workflow_steps
  WHERE workflow_run_id = @run_id AND node_id = @node_id
  ORDER BY execution_index, attempt LIMIT 1";

/// A retry from a named step: the run it retries, the node whose failed step runs again, and who
/// asked for it.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.run.retry handler")
)]
pub(crate) struct WorkflowRunRetry {
    /// The run retried.
    pub(crate) source_run_id: WorkflowRunId,
    /// The node whose latest step in the source run failed, which runs again with what it feeds.
    pub(crate) from_node_id: WorkflowNodeId,
    /// Who asked for the retry.
    pub(crate) started_by: WorkflowStartedBy,
}

/// The run a retry's write retries: its id, how the first run of its retries that is not a retry
/// was started (`None` where that run is gone), and whether the retry reuses its trigger's step.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.run.retry handler")
)]
pub(super) struct RetriedRun {
    /// The run retried.
    pub(super) workflow_run_id: WorkflowRunId,
    /// How the first run of its retries that is not a retry was started.
    pub(super) first_mode: Option<WorkflowRunMode>,
    /// Whether the retry reuses its trigger's step, so the write stores no trigger input.
    pub(super) is_trigger_reused: bool,
}

// Why a pooled read of a retry's source run failed: the pool, or the read itself.
#[derive(Debug, thiserror::Error)]
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.run.retry handler")
)]
enum RetryReadError {
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
}

// What a retry reads of its source run before anything is made.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.run.retry handler")
)]
struct SourceRun {
    workflow_version_id: WorkflowVersionId,
    session_id: SessionId,
    status: WorkflowRunStatus,
    trigger: WorkflowRunTrigger,
    first_mode: Option<WorkflowRunMode>,
    project_id: Option<ProjectId>,
    latest_step_status: Option<WorkflowStepStatus>,
}

impl WorkflowRunStarter {
    /// Retries `retry`: a new run in `retry` mode of the source run's pinned version, in its
    /// session, its project's workspace or the project's folder it worked in, recording the source
    /// run as the run it retries. Every node outside the named node and what it feeds whose steps
    /// in the source run settled is replayed from them, recorded as reused and never run again, its
    /// trigger's step among them, which then gets no row of its own. Refuses, with nothing made,
    /// `workflow.run.notFound` for a source run no row answers to, `workflow.run.stillRunning`
    /// (`sourceRunning`) while it is new, running or waiting, `workflow.step.notFound` for a node
    /// it holds no step of and `workflow.invalidTransition` for a node whose latest step did not
    /// fail, then as a start does; fails as a start does, and with
    /// [`WorkflowRunStartError::SourceRun`] or [`WorkflowRunStartError::ReusedOutput`] when the
    /// source run or a reused output does not read.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the workflow.run.retry handler")
    )]
    pub(crate) async fn retry(
        &self,
        retry: WorkflowRunRetry,
    ) -> Result<StartedRun, WorkflowRunStartError> {
        let WorkflowRunRetry {
            source_run_id,
            from_node_id,
            started_by,
        } = retry;
        let node_id = from_node_id.clone();
        let source = self
            .pool
            .read(ReadLength::Short, move |connection| {
                read_source_run(connection, source_run_id, &node_id)
                    .map_err(WorkflowRunStartError::SourceRun)
            })
            .await?;
        let source = refuse_unretriable(source_run_id, &from_node_id, source)?;
        let start = WorkflowRunStart {
            workflow_version_id: source.workflow_version_id,
            session_id: source.session_id,
            project_id: source.project_id,
            mode: WorkflowRunMode::Retry,
            trigger_kind: source.trigger.kind,
            arrival: WorkflowStartArrival::Person,
            started_by,
            chain: WorkflowRunChainPlace::Starts {},
            input: Vec::new(),
        };
        let mut checked = self.check(&start).await?;
        let graph = Arc::clone(&checked.graph);
        let trigger_id = checked.trigger_node.node_id.clone();
        let (plan, trigger_input) = self
            .pool
            .read(ReadLength::Short, move |connection| {
                let plan = plan_retry(connection, &graph, source_run_id, &from_node_id)?;
                let trigger_input = if plan.executed.contains(&trigger_id) {
                    Some(read_first_step_input(
                        connection,
                        source_run_id,
                        &trigger_id,
                    )?)
                } else {
                    None
                };
                Ok::<_, RetryReadError>((plan, trigger_input))
            })
            .await
            .map_err(|error| match error {
                RetryReadError::Pool(error) => WorkflowRunStartError::Pool(error),
                RetryReadError::Database(error) => WorkflowRunStartError::SourceRun(error),
            })?;
        let is_trigger_reused = trigger_input.is_none();
        // The trigger runs again on the items its source run's step started on.
        if let Some(trigger_input) = trigger_input {
            checked.start_items = read_step_payload(&*self.payloads, &trigger_input)
                .await
                .map_err(WorkflowRunStartError::ReusedOutput)?;
        }
        let node_run = StartedNodeRun::from_plan(&checked.graph, plan, &*self.payloads)
            .await
            .map_err(WorkflowRunStartError::ReusedOutput)?;
        let retried = RetriedRun {
            workflow_run_id: source_run_id,
            first_mode: source.first_mode,
            is_trigger_reused,
        };
        let WorkflowStartOutcome::Started(mut run) =
            self.start_checked(start, checked, Some(&retried)).await?
        else {
            unreachable!("a retry starts a chain of its own, which never holds it");
        };
        run.node_run = Some(node_run);
        Ok(run)
    }
}

// The source run `run_id` as a retry reads it, with the status of node `node_id`'s latest step in
// it; `None` where no run has the id.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.run.retry handler")
)]
fn read_source_run(
    connection: &Connection,
    run_id: WorkflowRunId,
    node_id: &WorkflowNodeId,
) -> rusqlite::Result<Option<SourceRun>> {
    let run_text = run_id.text();
    let source = connection
        .prepare_cached(SOURCE_RUN_SQL.as_str())?
        .query_row(named_params! { "@run_id": run_text.as_str() }, |row| {
            Ok(SourceRun {
                workflow_version_id: text_column(row, 0, |text| WorkflowVersionId::new(&text))?,
                session_id: text_column(row, 1, |text| SessionId::new(&text))?,
                status: text_column(row, 2, closed_word)?,
                trigger: text_column(row, 3, |text| serde_json::from_str(&text))?,
                first_mode: optional_text_column(row, 4, closed_word)?,
                project_id: optional_text_column(row, 5, |text| ProjectId::new(&text))?,
                latest_step_status: None,
            })
        })
        .optional()?;
    let Some(mut source) = source else {
        return Ok(None);
    };
    source.latest_step_status = connection
        .prepare_cached(LATEST_STEP_STATUS_SQL)?
        .query_row(
            named_params! { "@run_id": run_text.as_str(), "@node_id": node_id.as_str() },
            |row| text_column(row, 0, closed_word),
        )
        .optional()?;
    Ok(Some(source))
}

// The input node `node_id`'s first step in run `run_id` started on.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.run.retry handler")
)]
fn read_first_step_input(
    connection: &Connection,
    run_id: WorkflowRunId,
    node_id: &WorkflowNodeId,
) -> rusqlite::Result<WorkflowPayloadRef> {
    connection.prepare_cached(FIRST_STEP_INPUT_SQL)?.query_row(
        named_params! { "@run_id": run_id.text().as_str(), "@node_id": node_id.as_str() },
        |row| text_column(row, 0, |text| serde_json::from_str(&text)),
    )
}

// The source run, unless a retry of node `node_id` from run `run_id` is refused: no such run,
// a run still going, no step of the node, or a node whose latest step did not fail, in that order.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the workflow.run.retry handler")
)]
fn refuse_unretriable(
    run_id: WorkflowRunId,
    node_id: &WorkflowNodeId,
    source: Option<SourceRun>,
) -> Result<SourceRun, DomainError> {
    let Some(source) = source else {
        return Err(WorkflowNotFound::Run {
            workflow_run_id: run_id,
        }
        .into());
    };
    if GOING_RUN_STATUSES.contains(&source.status) {
        return Err(DomainError::new(
            format!("Workflow run {run_id} is still going: a step is retried once it stops."),
            RefusalCode::WorkflowRunStillRunning,
        )
        .with_detail(WorkflowRunStillRunningDetails {
            reason: WorkflowRunStillRunningReason::SourceRunning,
        }));
    }
    let node = node_id.as_str();
    match source.latest_step_status {
        None => Err(DomainError::new(
            format!("Workflow run {run_id} holds no step of node {node}."),
            RefusalCode::WorkflowStepNotFound,
        )
        .with_detail(json!({ "workflowRunId": run_id, "nodeId": node_id }))),
        Some(WorkflowStepStatus::Failed) => Ok(source),
        Some(_) => Err(DomainError::new(
            format!("The latest step of node {node} in workflow run {run_id} did not fail."),
            RefusalCode::WorkflowInvalidTransition,
        )
        .with_detail(json!({ "workflowRunId": run_id, "nodeId": node_id }))),
    }
}
