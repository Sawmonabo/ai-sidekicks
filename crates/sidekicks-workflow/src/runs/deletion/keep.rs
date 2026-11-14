//! The Keep mark that bulk delete leaves, set in the write that appends its
//! `workflow.run.keepChanged`, so a rebuild of the runs from the log keeps it.

use std::borrow::Cow;

use rusqlite::types::Value;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::workflow::run::events::WorkflowRunKeepChangedPayload;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::retention::WorkflowRunKeepSet;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::events::session::appender::{SessionEventDraft, SessionEventLinkage};

use crate::not_found::WorkflowNotFound;
use crate::runs::deletion::{WorkflowRunDeletion, WorkflowRunDeletionError};

// Sets or clears one run's Keep mark.
const KEEP_SQL: &str = "UPDATE workflow_runs SET kept = @kept WHERE id = @workflow_run_id";

impl WorkflowRunDeletion {
    /// Sets or clears the run's Keep mark and appends its `workflow.run.keepChanged` in that write.
    /// Fails with [`WorkflowRunDeletionError::NotFound`] for a run there is none of.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the workflow.run.keep.update handler")
    )]
    pub(crate) async fn set_keep(
        &self,
        keep_set: WorkflowRunKeepSet,
    ) -> Result<WorkflowRunKeepSet, WorkflowRunDeletionError> {
        let workflow_run_id = keep_set.workflow_run_id;
        let run = self.read_run(workflow_run_id).await?;
        let changed = SessionEventDraft::of_session(
            run.session_id,
            &SessionEvent::WorkflowRunKeepChanged(WorkflowRunKeepChangedPayload {
                session_id: run.session_id,
                workflow_run_id,
                definition_id: run.definition_id,
                workflow_version_id: run.workflow_version_id,
                kept: keep_set.keep,
            }),
        )?;
        let linkage = SessionEventLinkage {
            transactional_prelude: vec![keep_statement(workflow_run_id, keep_set.keep)],
            ..SessionEventLinkage::default()
        };
        match self.appender.append(changed, linkage).await {
            Ok(_) => Ok(keep_set),
            Err(error) if error.refused_statement_index().is_some() => {
                Err(WorkflowNotFound::Run { workflow_run_id }.into())
            }
            Err(error) => Err(error.into()),
        }
    }
}

/// The statement that sets run `workflow_run_id`'s Keep mark to `kept`, expecting one row: the Keep
/// mark's write and a rebuild of the runs from its `workflow.run.keepChanged` both apply it.
pub(crate) fn keep_statement(workflow_run_id: WorkflowRunId, kept: bool) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(KEEP_SQL),
        bindings: StatementBindings::Named(vec![
            (Cow::Borrowed("@kept"), Value::Integer(i64::from(kept))),
            text_binding("@workflow_run_id", workflow_run_id.text().as_str()),
        ]),
        expected_row_count: Some(1),
    }
}
