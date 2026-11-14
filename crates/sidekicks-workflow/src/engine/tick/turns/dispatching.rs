//! The turn's dispatch of what it readied: one read of the dispatching runs' workflows' levels,
//! then each run's steps still ready dispatched on a fresh snapshot of the run.

use std::collections::HashMap;
use std::sync::Arc;

use rusqlite::Connection;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::workflow::definition::document::WorkflowDefinitionId;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_store::database::connection::read_pool::{DatabaseReadError, ReadLength};
use sidekicks_store::database::stored_column::{closed_word, text_column};

use super::{EngineTick, failed_at_once, is_undispatched, step_failure};
use crate::engine::tick::{ReadyStep, RunSnapshot};
use crate::kinds::StepFailure;

// The level every step of the workflow's runs runs at, read again at each turn that dispatches.
const WORKFLOW_LEVEL_SQL: &str = "SELECT permission_level FROM workflow_definitions WHERE id = ?1";

/// Why the workflows' levels could not be read.
#[derive(Debug, thiserror::Error)]
enum WorkflowLevelReadError {
    /// SQLite refused the read, or a stored level did not read as one.
    #[error("a read of a workflow's level failed")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read's blocking task did not
    /// finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

impl EngineTick {
    /// Reads the levels of the dispatching runs' workflows in one read and dispatches each run's
    /// `readied` steps on a fresh snapshot, their answered reports opening its next batch. A run
    /// this turn ended is passed over, and so is a step it canceled or settled since it was
    /// readied. When the levels cannot be read, every one of those steps fails at once with that
    /// error.
    pub(super) async fn dispatch_readied(
        &mut self,
        dispatching: Vec<(WorkflowRunId, Vec<ReadyStep>)>,
    ) {
        let dispatching: Vec<(WorkflowRunId, Vec<ReadyStep>)> = dispatching
            .into_iter()
            .filter_map(|(run_id, mut readied)| {
                let live = self.runs.get(&run_id)?;
                readied.retain(|ready| {
                    live.steps
                        .get(&ready.step.execution_index.get())
                        .is_some_and(is_undispatched)
                });
                (!readied.is_empty()).then_some((run_id, readied))
            })
            .collect();
        if dispatching.is_empty() {
            return;
        }
        let mut workflow_ids: Vec<WorkflowDefinitionId> = Vec::new();
        for (run_id, _) in &dispatching {
            let workflow_id = self.runs[run_id].scope.workflow_id;
            if !workflow_ids.contains(&workflow_id) {
                workflow_ids.push(workflow_id);
            }
        }
        let levels = self
            .pool
            .read(ReadLength::Short, move |connection| {
                read_workflow_levels(connection, workflow_ids)
            })
            .await;
        for (run_id, readied) in dispatching {
            let live = self
                .runs
                .get_mut(&run_id)
                .expect("a dispatching run is live");
            match &levels {
                Ok(levels) => {
                    let snapshot = RunSnapshot {
                        outputs: Arc::new(live.outputs.clone()),
                        run_variables: Arc::clone(&live.run_variables),
                        permission_level: levels[&live.scope.workflow_id],
                    };
                    let execution_indices: Vec<u64> = readied
                        .iter()
                        .map(|ready| ready.step.execution_index.get())
                        .collect();
                    // The dispatch answers each step in the order it was handed.
                    let answered = self.dispatch.dispatch(&live.scope, &snapshot, readied);
                    for (execution_index, dispatched) in execution_indices.into_iter().zip(answered)
                    {
                        live.steps
                            .get_mut(&execution_index)
                            .expect("a dispatched step is live")
                            .cancel = Some(dispatched.cancel);
                        // Its driver takes back the run it made before the stop.
                        live.taken_back.remove(&execution_index);
                        live.next_batch.extend(dispatched.reports);
                    }
                }
                Err(error) => {
                    let message = format!("the workflow's level could not be read: {error}");
                    for ready in readied {
                        live.stop_taken_back(&self.dispatch, &ready.step).await;
                        let failure =
                            step_failure(live, &ready.step, StepFailure::Failed, message.clone());
                        live.next_batch.extend(failed_at_once(&ready.step, failure));
                    }
                }
            }
            if !live.next_batch.is_empty() && !self.batched.contains(&run_id) {
                self.batched.push(run_id);
            }
        }
    }
}

/// The level of each workflow of `workflow_ids`, one indexed query each.
fn read_workflow_levels(
    connection: &Connection,
    workflow_ids: Vec<WorkflowDefinitionId>,
) -> Result<HashMap<WorkflowDefinitionId, PermissionLevel>, WorkflowLevelReadError> {
    let mut statement = connection.prepare_cached(WORKFLOW_LEVEL_SQL)?;
    let mut levels = HashMap::with_capacity(workflow_ids.len());
    for workflow_id in workflow_ids {
        let level = statement.query_row([workflow_id.text().as_str()], |row| {
            text_column(row, 0, closed_word)
        })?;
        levels.insert(workflow_id, level);
    }
    Ok(levels)
}
